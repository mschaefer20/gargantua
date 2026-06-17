// WebGL2 engine for the solar system page.
// Computes orbital positions on the CPU each frame (so the camera can focus on
// any body), ray-traces the scene in the solar shader, then reuses the shared
// bloom + ACES composite passes. Orbit camera with smooth focus retargeting and
// adjustable time speed.

import { solarFrag } from '../shaders/solar.frag';
import {
  fullscreenVert,
  brightPassFrag,
  blurFrag,
  compositeFrag,
} from '../shaders/post';

export interface Body {
  name: string;
  radius: number;
  orbit: number;     // orbital radius (0 for sun)
  speed: number;     // orbital angular speed (relative)
  phase: number;
  parent?: number;   // index of body it orbits (for the Moon)
}

// Visually-compressed, not to scale — tuned so everything is framable at once.
export const BODIES: Body[] = [
  { name: 'Sun',     radius: 4.0,  orbit: 0,    speed: 0,    phase: 0 },
  { name: 'Mercury', radius: 0.34, orbit: 7.0,  speed: 1.60, phase: 0.4 },
  { name: 'Venus',   radius: 0.52, orbit: 9.6,  speed: 1.17, phase: 2.1 },
  { name: 'Earth',   radius: 0.55, orbit: 12.6, speed: 1.00, phase: 4.0 },
  { name: 'Mars',    radius: 0.42, orbit: 15.6, speed: 0.80, phase: 5.5 },
  { name: 'Jupiter', radius: 1.70, orbit: 21.5, speed: 0.43, phase: 1.0 },
  { name: 'Saturn',  radius: 1.45, orbit: 27.5, speed: 0.32, phase: 3.2 },
  { name: 'Uranus',  radius: 1.00, orbit: 32.5, speed: 0.23, phase: 0.8 },
  { name: 'Neptune', radius: 0.97, orbit: 36.5, speed: 0.18, phase: 5.0 },
  { name: 'Moon',    radius: 0.16, orbit: 1.35, speed: 6.00, phase: 0, parent: 3 },
];

export interface SolarSettings {
  timeSpeed: number;
  orbitLines: number;
  glow: number;
  bloomStrength: number;
  exposure: number;
  resScale: number;
  autoRotate: boolean;
}

export const defaultSolarSettings: SolarSettings = {
  timeSpeed: 1.0,
  orbitLines: 1.0,
  glow: 1.0,
  bloomStrength: 0.8,
  exposure: 1.1,
  resScale: 1.0,
  autoRotate: true,
};

interface FBO { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number; }

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

export class SolarRenderer {
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

  private azimuth = 0.6;
  private elevation = 0.45;
  private distance = 70.0;
  private targetDistance = 70.0;

  // focus target (world point the camera orbits)
  private focusIndex = 0;
  private target = new Float32Array([0, 0, 0]);

  private simTime = 0;
  private lastNow = performance.now();
  private startTime = performance.now();
  private raf = 0;
  private rw = 0;
  private rh = 0;
  private destroyed = false;

  // body buffers
  private posBuf = new Float32Array(BODIES.length * 3);
  private radBuf = new Float32Array(BODIES.length);
  private orbBuf = new Float32Array(BODIES.length);

  public settings: SolarSettings;
  public onFps?: (fps: number) => void;
  private fpsFrames = 0;
  private fpsLast = performance.now();

  constructor(canvas: HTMLCanvasElement, settings: SolarSettings) {
    this.canvas = canvas;
    this.settings = settings;
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');
    this.gl = gl;

    const extF = gl.getExtension('EXT_color_buffer_float');
    const extHF = gl.getExtension('EXT_color_buffer_half_float');
    if (extF || extHF) { this.texFormat = gl.RGBA16F; this.texType = gl.HALF_FLOAT; }
    else { this.texFormat = gl.RGBA8; this.texType = gl.UNSIGNED_BYTE; }
    gl.getExtension('OES_texture_float_linear');

    this.sceneProg = program(gl, solarFrag);
    this.brightProg = program(gl, brightPassFrag);
    this.blurProg = program(gl, blurFrag);
    this.compProg = program(gl, compositeFrag);
    this.vao = gl.createVertexArray()!;

    for (let i = 0; i < BODIES.length; i++) {
      this.radBuf[i] = BODIES[i].radius;
      this.orbBuf[i] = BODIES[i].orbit;
    }

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
    this.rw = w; this.rh = h;
    this.canvas.width = w; this.canvas.height = h;
    this.deleteFBO(this.sceneFBO); this.deleteFBO(this.bloomA); this.deleteFBO(this.bloomB);
    this.sceneFBO = this.createFBO(w, h);
    this.bloomA = this.createFBO(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.bloomB = this.createFBO(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  private computeBodies() {
    for (let i = 0; i < BODIES.length; i++) {
      const b = BODIES[i];
      const ang = b.phase + this.simTime * b.speed * 0.25;
      let x = Math.cos(ang) * b.orbit;
      let z = Math.sin(ang) * b.orbit;
      let y = 0;
      if (b.parent !== undefined) {
        x += this.posBuf[b.parent * 3];
        y += this.posBuf[b.parent * 3 + 1];
        z += this.posBuf[b.parent * 3 + 2];
      }
      this.posBuf[i * 3] = x;
      this.posBuf[i * 3 + 1] = y;
      this.posBuf[i * 3 + 2] = z;
    }
  }

  private cameraBasis(): { pos: Float32Array; mat: Float32Array } {
    const el = this.elevation, az = this.azimuth, ce = Math.cos(el);
    const tx = this.target[0], ty = this.target[1], tz = this.target[2];
    const pos = new Float32Array([
      tx + this.distance * ce * Math.sin(az),
      ty + this.distance * Math.sin(el),
      tz + this.distance * ce * Math.cos(az),
    ]);
    const fx = tx - pos[0], fy = ty - pos[1], fz = tz - pos[2];
    const fl = Math.hypot(fx, fy, fz);
    const f = [fx / fl, fy / fl, fz / fl];
    let rx = f[2], ry = 0, rz = -f[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = f[1] * rz - f[2] * ry;
    const uy = f[2] * rx - f[0] * rz;
    const uz = f[0] * ry - f[1] * rx;
    const mat = new Float32Array([rx, ry, rz, ux, uy, uz, f[0], f[1], f[2]]);
    return { pos, mat };
  }

  private drawQuad() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }
  private setF2(name: string, prog: WebGLProgram, a: number, b: number) {
    this.gl.uniform2f(this.gl.getUniformLocation(prog, name), a, b);
  }
  private bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  private renderFrame = () => {
    if (this.destroyed) return;
    const gl = this.gl;
    this.resize();

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const t = (now - this.startTime) / 1000;
    const s = this.settings;

    this.simTime += dt * s.timeSpeed;
    this.computeBodies();

    // smooth focus retarget
    const fi = this.focusIndex;
    const tx = this.posBuf[fi * 3], ty = this.posBuf[fi * 3 + 1], tz = this.posBuf[fi * 3 + 2];
    this.target[0] += (tx - this.target[0]) * Math.min(1, dt * 4);
    this.target[1] += (ty - this.target[1]) * Math.min(1, dt * 4);
    this.target[2] += (tz - this.target[2]) * Math.min(1, dt * 4);

    if (s.autoRotate) this.azimuth += 0.0008;
    this.distance += (this.targetDistance - this.distance) * 0.08;

    const { pos, mat } = this.cameraBasis();
    gl.bindVertexArray(this.vao);

    // Pass 1: scene -> HDR
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.sceneProg);
    this.setF2('u_resolution', this.sceneProg, this.rw, this.rh);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_time'), t * s.timeSpeed + this.simTime);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'u_camPos'), pos);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.sceneProg, 'u_camMat'), false, mat);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_fov'), 1.0);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'u_pos'), this.posBuf);
    gl.uniform1fv(gl.getUniformLocation(this.sceneProg, 'u_rad'), this.radBuf);
    gl.uniform1fv(gl.getUniformLocation(this.sceneProg, 'u_orbitR'), this.orbBuf);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_orbitLines'), s.orbitLines);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_exposureGlow'), s.glow);
    this.drawQuad();

    // Pass 2: bright extract
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    gl.useProgram(this.brightProg);
    this.bindTex(this.brightProg, 'u_tex', this.sceneFBO.tex, 0);
    gl.uniform1f(gl.getUniformLocation(this.brightProg, 'u_threshold'), 0.8);
    this.drawQuad();

    // Pass 3: blur x2
    for (let i = 0; i < 3; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fb);
      gl.viewport(0, 0, this.bloomB.w, this.bloomB.h);
      gl.useProgram(this.blurProg);
      this.bindTex(this.blurProg, 'u_tex', this.bloomA.tex, 0);
      this.setF2('u_dir', this.blurProg, 1.0 / this.bloomA.w, 0);
      this.drawQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
      gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
      this.bindTex(this.blurProg, 'u_tex', this.bloomB.tex, 0);
      this.setF2('u_dir', this.blurProg, 0, 1.0 / this.bloomB.h);
      this.drawQuad();
    }

    // Pass 4: composite -> screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.compProg);
    this.bindTex(this.compProg, 'u_scene', this.sceneFBO.tex, 0);
    this.bindTex(this.compProg, 'u_bloom', this.bloomA.tex, 1);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_bloomStrength'), s.bloomStrength);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_exposure'), s.exposure);
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_time'), t);
    this.drawQuad();

    this.fpsFrames++;
    if (now - this.fpsLast >= 500) {
      this.onFps?.((this.fpsFrames * 1000) / (now - this.fpsLast));
      this.fpsFrames = 0; this.fpsLast = now;
    }
    this.raf = requestAnimationFrame(this.renderFrame);
  };

  // Focus the camera on a body and pull in to a sensible distance.
  focus(index: number) {
    this.focusIndex = index;
    const r = BODIES[index].radius;
    this.targetDistance = index === 0 ? 70.0 : Math.max(3.0, r * 7.0);
    this.settings.autoRotate = index === 0;
  }

  private attachControls() {
    const c = this.canvas;
    let dragging = false, lastX = 0, lastY = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      this.settings.autoRotate = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist > 0) this.zoom((pinchDist - d) * 0.08);
        pinchDist = d; return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.azimuth -= dx * 0.006;
      this.elevation = Math.max(-1.5, Math.min(1.5, this.elevation + dy * 0.006));
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) dragging = false;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY * 0.04); }, { passive: false });
  }
  private zoom(amount: number) {
    const min = this.focusIndex === 0 ? 12 : 2;
    this.targetDistance = Math.max(min, Math.min(120, this.targetDistance + amount));
  }

  start() { this.lastNow = performance.now(); this.raf = requestAnimationFrame(this.renderFrame); }
  stop() { cancelAnimationFrame(this.raf); }
  destroy() { this.destroyed = true; this.stop(); }
  resetView() {
    this.azimuth = 0.6; this.elevation = 0.45;
    this.focus(0);
    this.settings.autoRotate = true;
  }
}
