// WebGL2 engine for the black hole simulator.
// Renders the geodesic scene to an HDR float target, runs a two-iteration
// bloom, then composites with tonemapping. Handles orbit/zoom camera controls,
// resolution scaling, and exposes a small live-tunable settings object.

import { sceneFrag } from '../shaders/scene.frag';
import {
  fullscreenVert,
  brightPassFrag,
  blurFrag,
  compositeFrag,
} from '../shaders/post';

export interface Settings {
  diskIntensity: number;
  lensing: number;
  diskOpacity: number;
  starBrightness: number;
  bloomStrength: number;
  exposure: number;
  quality: number;       // step-count multiplier
  resScale: number;      // render resolution multiplier (0.5..1.5)
  autoRotate: boolean;
}

export const defaultSettings: Settings = {
  diskIntensity: 1.0,
  lensing: 1.0,
  diskOpacity: 1.0,
  starBrightness: 1.0,
  bloomStrength: 0.78,
  exposure: 1.0,
  quality: 1.0,
  resScale: 1.0,
  autoRotate: true,
};

interface FBO {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, frag: string, vert = fullscreenVert) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class BlackHoleRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;

  private sceneProg: WebGLProgram;
  private brightProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private compProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private sceneFBO!: FBO;
  private bloomA!: FBO;
  private bloomB!: FBO;

  private texFormat: number;
  private texType: number;

  // camera state (spherical orbit)
  private azimuth = 0.6;
  private elevation = 0.16;
  private distance = 16.0;
  private targetDistance = 16.0;

  private startTime = performance.now();
  private raf = 0;
  private rw = 0;
  private rh = 0;
  private destroyed = false;

  public settings: Settings;
  public onFps?: (fps: number) => void;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsLast = performance.now();

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = settings;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');
    this.gl = gl;

    // Prefer float render targets for HDR bloom; fall back gracefully.
    const extF = gl.getExtension('EXT_color_buffer_float');
    const extHF = gl.getExtension('EXT_color_buffer_half_float');
    if (extF) {
      this.texFormat = gl.RGBA16F;
      this.texType = gl.HALF_FLOAT;
    } else if (extHF) {
      this.texFormat = gl.RGBA16F;
      this.texType = gl.HALF_FLOAT;
    } else {
      this.texFormat = gl.RGBA8;
      this.texType = gl.UNSIGNED_BYTE;
    }
    gl.getExtension('OES_texture_float_linear');

    this.sceneProg = program(gl, sceneFrag);
    this.brightProg = program(gl, brightPassFrag);
    this.blurProg = program(gl, blurFrag);
    this.compProg = program(gl, compositeFrag);
    this.vao = gl.createVertexArray()!;

    this.attachControls();
    this.resize();
  }

  private createFBO(w: number, h: number): FBO {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.texFormat, w, h, 0, gl.RGBA, this.texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  private deleteFBO(f?: FBO) {
    if (!f) return;
    this.gl.deleteTexture(f.tex);
    this.gl.deleteFramebuffer(f.fb);
  }

  resize() {
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2.0); // supersample for AA
    const scale = this.settings.resScale * dpr;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * scale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * scale));
    if (w === this.rw && h === this.rh) return;
    this.rw = w;
    this.rh = h;
    this.canvas.width = w;
    this.canvas.height = h;

    this.deleteFBO(this.sceneFBO);
    this.deleteFBO(this.bloomA);
    this.deleteFBO(this.bloomB);
    this.sceneFBO = this.createFBO(w, h);
    // Bloom at half resolution for performance + softer glow.
    const bw = Math.max(1, w >> 1);
    const bh = Math.max(1, h >> 1);
    this.bloomA = this.createFBO(bw, bh);
    this.bloomB = this.createFBO(bw, bh);
  }

  private cameraBasis(): { pos: Float32Array; mat: Float32Array } {
    const el = this.elevation;
    const az = this.azimuth;
    const ce = Math.cos(el);
    const pos = new Float32Array([
      this.distance * ce * Math.sin(az),
      this.distance * Math.sin(el),
      this.distance * ce * Math.cos(az),
    ]);
    // forward = look at origin
    const fx = -pos[0], fy = -pos[1], fz = -pos[2];
    const fl = Math.hypot(fx, fy, fz);
    const f = [fx / fl, fy / fl, fz / fl];
    // right = normalize(cross(worldUp, f))
    const up0 = [0, 1, 0];
    let rx = up0[1] * f[2] - up0[2] * f[1];
    let ry = up0[2] * f[0] - up0[0] * f[2];
    let rz = up0[0] * f[1] - up0[1] * f[0];
    const rl = Math.hypot(rx, ry, rz);
    rx /= rl; ry /= rl; rz /= rl;
    // up = cross(f, right)
    const ux = f[1] * rz - f[2] * ry;
    const uy = f[2] * rx - f[0] * rz;
    const uz = f[0] * ry - f[1] * rx;
    // column-major mat3: columns are right, up, forward
    const mat = new Float32Array([
      rx, ry, rz,
      ux, uy, uz,
      f[0], f[1], f[2],
    ]);
    return { pos, mat };
  }

  private drawQuad() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private renderFrame = () => {
    if (this.destroyed) return;
    const gl = this.gl;
    this.resize();

    const t = (performance.now() - this.startTime) / 1000;
    const s = this.settings;

    if (s.autoRotate) this.azimuth += 0.0016;
    // smooth zoom
    this.distance += (this.targetDistance - this.distance) * 0.08;

    const { pos, mat } = this.cameraBasis();
    gl.bindVertexArray(this.vao);

    // ---- Pass 1: scene -> HDR target ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.sceneProg);
    this.setF2('u_resolution', this.sceneProg, this.rw, this.rh);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_time'), t);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'u_camPos'), pos);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.sceneProg, 'u_camMat'), false, mat);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_fov'), 1.0);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_diskIntensity'), s.diskIntensity);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_lensing'), s.lensing);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_diskOpacity'), s.diskOpacity);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_starBrightness'), s.starBrightness);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_quality'), s.quality);
    this.drawQuad();

    // ---- Pass 2: bright extract -> bloomA ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    gl.useProgram(this.brightProg);
    this.bindTex(this.brightProg, 'u_tex', this.sceneFBO.tex, 0);
    gl.uniform1f(gl.getUniformLocation(this.brightProg, 'u_threshold'), 0.7);
    this.drawQuad();

    // ---- Pass 3: separable Gaussian blur, two iterations ----
    for (let i = 0; i < 3; i++) {
      // horizontal: bloomA -> bloomB
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fb);
      gl.viewport(0, 0, this.bloomB.w, this.bloomB.h);
      gl.useProgram(this.blurProg);
      this.bindTex(this.blurProg, 'u_tex', this.bloomA.tex, 0);
      this.setF2('u_dir', this.blurProg, 1.0 / this.bloomA.w, 0);
      this.drawQuad();
      // vertical: bloomB -> bloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
      gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
      this.bindTex(this.blurProg, 'u_tex', this.bloomB.tex, 0);
      this.setF2('u_dir', this.blurProg, 0, 1.0 / this.bloomB.h);
      this.drawQuad();
    }

    // ---- Pass 4: composite -> screen ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.compProg);
    this.bindTex(this.compProg, 'u_scene', this.sceneFBO.tex, 0);
    this.bindTex(this.compProg, 'u_bloom', this.bloomA.tex, 1);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_bloomStrength'), s.bloomStrength);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_exposure'), s.exposure);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_time'), t);
    this.drawQuad();

    // fps
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.fpsLast >= 500) {
      const fps = (this.fpsFrames * 1000) / (now - this.fpsLast);
      this.onFps?.(fps);
      this.fpsFrames = 0;
      this.fpsLast = now;
    }

    this.raf = requestAnimationFrame(this.renderFrame);
  };

  private setF2(name: string, prog: WebGLProgram, a: number, b: number) {
    this.gl.uniform2f(this.gl.getUniformLocation(prog, name), a, b);
  }
  private bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  // ---------- input ----------
  private attachControls() {
    const c = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;

    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.settings.autoRotate = false;
    };
    const move = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist > 0) this.zoom((pinchDist - d) * 0.03);
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.azimuth -= dx * 0.006;
      this.elevation = Math.max(-1.45, Math.min(1.45, this.elevation + dy * 0.006));
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) dragging = false;
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY * 0.012);
    }, { passive: false });
  }

  private zoom(amount: number) {
    this.targetDistance = Math.max(5.0, Math.min(45.0, this.targetDistance + amount));
  }

  start() {
    this.raf = requestAnimationFrame(this.renderFrame);
  }
  stop() {
    cancelAnimationFrame(this.raf);
  }
  destroy() {
    this.destroyed = true;
    this.stop();
  }
  resetView() {
    this.azimuth = 0.6;
    this.elevation = 0.16;
    this.targetDistance = 16.0;
    this.settings.autoRotate = true;
  }
}
