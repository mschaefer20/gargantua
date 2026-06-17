import { Engine, type BaseSettings } from './engine';
import { supernovaFrag } from '../shaders/supernova.frag';

export interface SupernovaSettings extends BaseSettings {
  period: number;     // seconds per explosion cycle
  intensity: number;
}

export const defaultSupernovaSettings: SupernovaSettings = {
  period: 11.0,
  intensity: 1.0,
  exposure: 1.0,
  bloomStrength: 1.1,
  resScale: 1.0,
  autoRotate: true,
};

export class SupernovaRenderer extends Engine<SupernovaSettings> {
  constructor(canvas: HTMLCanvasElement, settings: SupernovaSettings) {
    super(canvas, supernovaFrag, settings, {
      bloomThreshold: 0.7,
      distance: 24,
      minDistance: 6,
      maxDistance: 70,
      elevation: 0.18,
      rotateSpeed: 0.0008,
    });
  }
  protected setSceneUniforms(): void {
    const gl = this.gl;
    gl.uniform1f(this.u('u_period'), this.settings.period);
    gl.uniform1f(this.u('u_intensity'), this.settings.intensity);
  }
}
