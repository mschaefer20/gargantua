import { Engine, type BaseSettings } from './engine';
import { pulsarFrag } from '../shaders/pulsar.frag';

export interface PulsarSettings extends BaseSettings {
  beamIntensity: number;
  spinRate: number;
  tilt: number;
  starGlow: number;
}

export const defaultPulsarSettings: PulsarSettings = {
  beamIntensity: 1.0,
  spinRate: 2.2,
  tilt: 0.5,
  starGlow: 1.0,
  exposure: 1.05,
  bloomStrength: 1.0,
  resScale: 1.0,
  autoRotate: true,
};

export class PulsarRenderer extends Engine<PulsarSettings> {
  constructor(canvas: HTMLCanvasElement, settings: PulsarSettings) {
    super(canvas, pulsarFrag, settings, {
      bloomThreshold: 0.55,
      distance: 14,
      minDistance: 3.5,
      maxDistance: 50,
      elevation: 0.22,
      rotateSpeed: 0.0010,
    });
  }
  protected setSceneUniforms(): void {
    const gl = this.gl;
    gl.uniform1f(this.u('u_beamIntensity'), this.settings.beamIntensity);
    gl.uniform1f(this.u('u_spinRate'), this.settings.spinRate);
    gl.uniform1f(this.u('u_tilt'), this.settings.tilt);
    gl.uniform1f(this.u('u_starGlow'), this.settings.starGlow);
  }
}
