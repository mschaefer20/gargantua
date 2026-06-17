import { Engine, type BaseSettings } from './engine';
import { nebulaFrag } from '../shaders/nebula.frag';

export interface NebulaSettings extends BaseSettings {
  density: number;
  brightness: number;
  starBrightness: number;
}

export const defaultNebulaSettings: NebulaSettings = {
  density: 1.0,
  brightness: 1.0,
  starBrightness: 1.0,
  exposure: 1.15,
  bloomStrength: 0.8,
  resScale: 1.0,
  autoRotate: true,
};

export class NebulaRenderer extends Engine<NebulaSettings> {
  constructor(canvas: HTMLCanvasElement, settings: NebulaSettings) {
    super(canvas, nebulaFrag, settings, {
      bloomThreshold: 0.6,
      distance: 17,
      minDistance: 4,
      maxDistance: 55,
      elevation: 0.25,
      rotateSpeed: 0.0007,
    });
  }
  protected setSceneUniforms(): void {
    const gl = this.gl;
    gl.uniform1f(this.u('u_density'), this.settings.density);
    gl.uniform1f(this.u('u_brightness'), this.settings.brightness);
    gl.uniform1f(this.u('u_starBrightness'), this.settings.starBrightness);
  }
}
