// WebGL2 engine for the wormhole traversal page.
// Renders the tunnel shader to an HDR target, then reuses the shared bloom +
// ACES composite passes. Auto-flies forward; the mouse steers, click/hold
// boosts to warp speed. Mirrors BlackHoleRenderer's pipeline structure.

import { wormholeFrag } from '../shaders/wormhole.frag';
import {
  fullscreenVert,
  brightPassFrag,
  blurFrag,
  compositeFrag,
} from '../shaders/post';

export interface WormholeSettings {
  speed: number;        // cruise speed
  warp: number;         // streak intensity
  throat: number;       // throat-glow intensity
  bloomStrength: number;
  exposure: number;
  resScale: number;
}

export const defaultWormholeSettings: WormholeSettings = {
  speed: 5.0,
  warp: 1.0,
  throat: 1.0,
  bloomStrength: 0.5,
  exposure: 1.05,
  resScale: 1.0,
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

export class WormholeRenderer {
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

  private startTime = performance.now();
  private raf = 0;
  private rw = 0;
  private rh = 0;
  private destroyed = false;

  // travel + steering state
  private flyTime = 0;          // integrated distance/time (so speed changes stay continuous)
  private lastNow = performance.now();
  private curSpeed = 6.0;
  private boosting = false;
  private mouseX = 0;
  private mouseY = 0;
  private tgtMouseX = 0;
  private tgtMouseY = 0;

  public settings: WormholeSettings;
  public onFps?: (fps: number) => void;
  private fpsFrames = 0;
  private fpsLast = performance.now();

  constructor(canvas: HTMLCanvasElement, settings: WormholeSettings) {
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

    this.sceneProg = program(gl, wormholeFrag);
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
    this.rw = w; this.rh = h;
    this.canvas.width = w; this.canvas.height = h;
    this.deleteFBO(this.sceneFBO); this.deleteFBO(this.bloomA); this.deleteFBO(this.bloomB);
    this.sceneFBO = this.createFBO(w, h);
    this.bloomA = this.createFBO(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.bloomB = this.createFBO(Math.max(1, w >> 1), Math.max(1, h >> 1));
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

    // Integrate fly-time so speed changes (boost) never cause jumps.
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;

    const s = this.settings;
    const targetSpeed = this.boosting ? s.speed * 3.2 : s.speed;
    this.curSpeed += (targetSpeed - this.curSpeed) * Math.min(1, dt * 3.0);
    this.flyTime += dt * this.curSpeed * 0.16;

    // Smooth the steering.
    this.mouseX += (this.tgtMouseX - this.mouseX) * Math.min(1, dt * 4.0);
    this.mouseY += (this.tgtMouseY - this.mouseY) * Math.min(1, dt * 4.0);

    const warp = s.warp * (this.boosting ? 1.6 : 1.0);

    gl.bindVertexArray(this.vao);

    // Pass 1: scene -> HDR
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fb);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.sceneProg);
    this.setF2('u_resolution', this.sceneProg, this.rw, this.rh);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_time'), this.flyTime);
    this.setF2('u_mouse', this.sceneProg, this.mouseX, this.mouseY);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_speed'), this.curSpeed);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_warp'), warp);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'u_throat'), s.throat);
    this.drawQuad();

    // Pass 2: bright extract
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    gl.useProgram(this.brightProg);
    this.bindTex(this.brightProg, 'u_tex', this.sceneFBO.tex, 0);
    gl.uniform1f(gl.getUniformLocation(this.brightProg, 'u_threshold'), 0.85);
    this.drawQuad();

    // Pass 3: separable blur x2
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
    gl.uniform1f(gl.getUniformLocation(this.compProg, 'u_time'), this.flyTime);
    this.drawQuad();

    this.fpsFrames++;
    if (now - this.fpsLast >= 500) {
      this.onFps?.((this.fpsFrames * 1000) / (now - this.fpsLast));
      this.fpsFrames = 0; this.fpsLast = now;
    }
    this.raf = requestAnimationFrame(this.renderFrame);
  };

  private attachControls() {
    const c = this.canvas;
    const onMove = (x: number, y: number) => {
      const rect = c.getBoundingClientRect();
      this.tgtMouseX = ((x - rect.left) / rect.width - 0.5) * 2.0;
      this.tgtMouseY = -((y - rect.top) / rect.height - 0.5) * 2.0;
    };
    c.addEventListener('pointermove', (e) => onMove(e.clientX, e.clientY));
    const boostOn = () => (this.boosting = true);
    const boostOff = () => (this.boosting = false);
    c.addEventListener('pointerdown', boostOn);
    window.addEventListener('pointerup', boostOff);
    c.addEventListener('pointercancel', boostOff);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.settings.speed = Math.max(1.5, Math.min(20, this.settings.speed - e.deltaY * 0.01));
    }, { passive: false });
    // Keyboard: hold space to boost.
    window.addEventListener('keydown', (e) => { if (e.code === 'Space') this.boosting = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.boosting = false; });
  }

  setBoost(v: boolean) { this.boosting = v; }
  start() { this.lastNow = performance.now(); this.raf = requestAnimationFrame(this.renderFrame); }
  stop() { cancelAnimationFrame(this.raf); }
  destroy() { this.destroyed = true; this.stop(); }
}
