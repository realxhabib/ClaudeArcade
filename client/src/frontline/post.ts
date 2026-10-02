/**
 * High tier post-processing (pmndrs `postprocessing` + N8AO):
 *
 *   world render → ambient occlusion (N8AO, half res) → the first-person
 *   weapon over a cleared depth buffer (so it gets no AO from the world) →
 *   sanitize (see below) → bloom (muzzle flashes, fire, sun glints on wet asphalt) → ACES tone
 *   mapping → color grade (lift / gamma / gain, split toning, saturation),
 *   vignette and a little film grain → SMAA.
 *
 * Medium and low render straight to the screen with the renderer's own tone
 * mapping and MSAA (or none) instead.
 */

import { HalfFloatType, Uniform, Vector3, type Camera, type PerspectiveCamera, type Scene, type WebGLRenderTarget, type WebGLRenderer } from "three";
import { BlendFunction, BloomEffect, Effect, EffectComposer, EffectPass, Pass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { N8AOPostPass } from "n8ao";

const GRADE = /* glsl */ `
uniform vec3 lift;
uniform vec3 gamma;
uniform vec3 gain;
uniform float saturation;
uniform float tone;
uniform float vignette;
uniform float grain;
uniform float time;
uniform float flash;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  c = gain * (c + lift * (1.0 - c));
  c = pow(c, 1.0 / gamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  // Split toning: cool teal shadows, warm highlights.
  c += tone * ((1.0 - l) * vec3(-0.012, 0.004, 0.018) + l * vec3(0.024, 0.01, -0.02));
  vec2 d = uv - 0.5;
  c *= 1.0 - vignette * smoothstep(0.1, 0.75, dot(d, d) * 2.2);
  c += flash * vec3(1.0, 0.85, 0.6);
  float n = hash12(uv * vec2(1920.0, 1080.0) + fract(time) * 917.0) - 0.5;
  c += n * grain * (1.0 - l * 0.6);
  outputColor = vec4(c, inputColor.a);
}
`;

/**
 * A sharp sun glint (low roughness, grazing Fresnel) can overflow the half
 * float buffer to Inf, and bad math can leave a NaN. Bloom's blur would then
 * smear that one pixel over the whole screen and tone mapping turns it into
 * black: a full-frame black flash at certain angles while moving. Clamp every
 * pixel to a sane HDR range (an overflowed glint stays bright, a NaN goes
 * black) before anything blurs it.
 */
const SANITIZE = /* glsl */ `
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  // NaN fails every comparison (some compilers fold isnan() away).
  bool bad = !(c.r == c.r) || !(c.g == c.g) || !(c.b == c.b) || any(isnan(c));
  c = bad ? vec3(0.0) : clamp(c, 0.0, 64.0);
  outputColor = vec4(c, inputColor.a);
}
`;

class SanitizeEffect extends Effect {
  constructor() {
    super("SanitizeEffect", SANITIZE, { blendFunction: BlendFunction.SET });
  }
}

class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["lift", new Uniform(new Vector3(-0.006, -0.004, 0.004))],
        ["gamma", new Uniform(new Vector3(0.94, 0.93, 0.92))],
        ["gain", new Uniform(new Vector3(1.08, 1.04, 0.98))],
        ["saturation", new Uniform(1.02)],
        ["tone", new Uniform(1)],
        ["vignette", new Uniform(0.42)],
        ["grain", new Uniform(0.028)],
        ["time", new Uniform(0)],
        ["flash", new Uniform(0)],
      ]),
    });
  }

  set time(t: number) {
    this.uniforms.get("time")!.value = t;
  }

  /** A brief whiteout (explosions close by), 0…1. */
  set flash(v: number) {
    this.uniforms.get("flash")!.value = v;
  }
}

/** Draws another scene (the first-person weapon) over the current buffer after clearing depth. */
class OverlayPass extends Pass {
  constructor(
    private readonly overlay: Scene,
    private readonly overlayCamera: Camera,
    private readonly visible: () => boolean,
  ) {
    super("OverlayPass");
    this.needsSwap = false;
  }

  render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null): void {
    if (!this.visible()) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.clearDepth();
    renderer.render(this.overlay, this.overlayCamera);
    renderer.autoClear = auto;
  }
}

export class PostFx {
  readonly composer: EffectComposer;
  private readonly ao: N8AOPostPass;
  private readonly grade = new GradeEffect();
  private readonly bloom: BloomEffect;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, overlay: { scene: Scene; camera: Camera; visible: () => boolean }) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0, stencilBuffer: false });
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new N8AOPostPass(scene, camera, 1, 1);
    const cfg = this.ao.configuration;
    cfg.aoRadius = 1.6;
    cfg.distanceFalloff = 0.35;
    cfg.intensity = 2.6;
    cfg.halfRes = true;
    cfg.depthAwareUpsampling = true;
    cfg.aoSamples = 12;
    cfg.denoiseSamples = 6;
    cfg.denoiseRadius = 10;
    cfg.gammaCorrection = false;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OverlayPass(overlay.scene, overlay.camera, overlay.visible));
    // Its own pass: bloom reads the input buffer before its pass's shader runs.
    this.composer.addPass(new EffectPass(camera, new SanitizeEffect()));
    this.bloom = new BloomEffect({ intensity: 0.5, luminanceThreshold: 1.35, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.6 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.composer.addPass(new EffectPass(camera, this.bloom, tone, this.grade));
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  render(dt: number, t: number, flash: number): void {
    this.grade.time = t;
    this.grade.flash = flash;
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
