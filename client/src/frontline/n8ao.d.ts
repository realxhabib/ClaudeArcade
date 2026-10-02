// Minimal types for n8ao (it ships none): the post-processing pass Frontline uses.
declare module "n8ao" {
  import type { Camera, Color, Scene } from "three";
  import { Pass } from "postprocessing";

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: Color;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    renderMode: number;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
    setSize(width: number, height: number): void;
  }
}
