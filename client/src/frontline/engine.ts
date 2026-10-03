/**
 * One match on screen: owns the WebGL renderer (on a canvas made fresh for
 * each mount), the scene, cameras, soldier rigs, the first-person weapon,
 * effects, sound and input, and runs the frame loop:
 *
 *   input → aim assist → game.update → camera → rigs / viewmodel / effects
 *   → render (world, then the weapon over a cleared depth buffer) → overlays
 *
 * The DOM overlays that change every frame (crosshair, hit markers, damage
 * arrows, vignette, scope, minimap, compass, name tag) are written here
 * directly; React only renders the slower HUD from `game.hud()`.
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  FogExp2,
  HemisphereLight,
  Matrix4,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
  type WebGLRenderTarget,
} from "three";
import type { AssetPack } from "./assets";
import { FrontAudio } from "./audio";
import { AvatarKit, SEAT_COLORS, SoldierRig, TEAM_COLORS } from "./avatars";
import { PostFx } from "./post";
import { SkinnedSoldier, SoldierKit } from "./soldier";
import { RUN_SPEED, idleIntent, type FeedEntry, type Game, type GameFx, type Impact, type Intent, type Soldier } from "./game";
import { F_RELOAD } from "./net";
import { Input } from "./input";
import { lineOfSight, raycastMap, rayPlayer, viewDir, type Vec3 } from "./physics";
import { FrameGovernor, TIERS, type Tier } from "./quality";
import type { Settings } from "./settings";
import { NadeFx } from "./nadefx";
import { fireTexture, flashTexture, holeTexture, scorchTexture, smokeTexture, softDot, streakTexture } from "./textures";
import { Vfx } from "./vfx";
import { ViewModel } from "./viewmodel";
import { BASE_FOV, spreadDeg, type WeaponDef } from "./weapons";
import { buildWorld, type WorldView } from "./world";

const DEG = Math.PI / 180;

export interface Overlay {
  crosshair: HTMLElement | null;
  hitmarker: HTMLElement | null;
  damage: HTMLElement[];
  vignette: HTMLElement | null;
  scope: HTMLElement | null;
  minimap: HTMLCanvasElement | null;
  compass: HTMLElement | null;
  nametag: HTMLElement | null;
  flash: HTMLElement | null;
}

export type Callout =
  | { kind: "kill"; name: string; headshot: boolean; streak: number }
  | { kind: "radar" }
  | { kind: "first_blood" }
  | { kind: "spawn" };

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  game: Game;
  tier: Tier;
  /** Downloaded textures / sky / soldier for the tier's asset level (see assets.ts). */
  pack: AssetPack;
  reduceMotion: boolean;
  touch: boolean;
  settings: () => Settings;
  haptic: (style: "light" | "medium" | "heavy" | "success") => void;
  /** Auto quality gave up on this tier (resolution already at its floor). */
  onGiveUp: () => void;
}

interface DamageArrow {
  x: number;
  z: number;
  at: number;
}

const _v = new Vector3();
const _w = new Vector3();

/** A soldier's third-person body: the animated one (medium/high) or the blocky one (low). */
type Rig = { kind: "skinned"; rig: SkinnedSoldier } | { kind: "blocky"; rig: SoldierRig };

export class Engine {
  readonly game: Game;
  readonly input = new Input();
  readonly audio = new FrontAudio();
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(BASE_FOV, 1, 0.05, 600);
  private readonly world: WorldView;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly kit: AvatarKit;
  private readonly skinKit: SoldierKit | null;
  private readonly rigs = new Map<string, Rig>();
  private readonly pack: AssetPack;
  private envTarget: WebGLRenderTarget | null = null;
  private post: PostFx | null = null;
  /** Brief whiteout (close explosions), fed to the grade. */
  flashAmount = 0;
  private readonly vm: ViewModel;
  private readonly nadeFx: NadeFx;
  private readonly vfx: Vfx;
  private readonly textures: Texture[];
  private readonly governor: FrameGovernor;
  private readonly opts: EngineOptions;
  private tier: Tier;
  private overlay: Overlay = { crosshair: null, hitmarker: null, damage: [], vignette: null, scope: null, minimap: null, compass: null, nametag: null, flash: null };
  private raf = 0;
  private hiddenTimer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private width = 1;
  private height = 1;
  private disposed = false;
  paused = false;
  private pausedAt = 0;
  private readonly intent: Intent = idleIntent();
  // Camera feel.
  private trauma = 0;
  private landDip = 0;
  private punch = 0;
  private fov = BASE_FOV;
  /** Tall (portrait) screens widen the view so it never gets narrower than ~54° across. */
  private fovScale = 1;
  private lookX = 0;
  private lookY = 0;
  // Overlays.
  private hitAt = -1e9;
  private hitKind: "hit" | "kill" | "head" = "hit";
  private readonly arrows: DamageArrow[] = [];
  private hurtAt = -1e9;
  private minimapAt = 0;
  private mapImage: HTMLCanvasElement | null = null;
  private deathCam: { x: number; y: number; z: number; yaw: number; pitch: number; at: number } | null = null;
  // Spectating.
  watch: string | null = null;
  freeCam = false;
  private free = { x: 0, y: 14, z: 30, yaw: 0, pitch: -0.45 };
  private callouts = new Set<(c: Callout) => void>();
  private startedAt = 0;
  /** "NPC" tags floating over the bots, by soldier id (made as bots appear). */
  private npcTags = new Map<string, HTMLDivElement>();

  constructor(o: EngineOptions) {
    this.opts = o;
    this.game = o.game;
    this.tier = o.tier;
    const t = TIERS[o.tier];
    this.pack = o.pack;
    const pbr = o.pack.level !== "lo";
    this.renderer = new WebGLRenderer({ canvas: o.canvas, antialias: t.antialias, powerPreference: "high-performance", stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = t.post ? NoToneMapping : ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = pbr ? 1.0 : 1.18;
    this.renderer.autoClear = false;
    // Count draw calls over the whole frame (world + weapon passes), not per pass.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = t.shadows;
    this.renderer.shadowMap.type = PCFShadowMap;
    const dpr = Math.min(window.devicePixelRatio || 1, t.dpr);
    this.governor = new FrameGovernor(dpr, Math.min(dpr, t.minDpr));
    this.governor.onGiveUp = () => this.opts.onGiveUp();
    this.renderer.setPixelRatio(dpr);
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    for (const m of Object.values(o.pack.mats)) for (const tex of [m.albedo, m.normal, m.arm]) if (tex) tex.anisotropy = Math.min(aniso, pbr ? 8 : 2);

    const map = this.game.map;
    const [sx, sy, sz] = map.sun;
    this.sunDir.set(sx, sy, sz).normalize();
    if (pbr && o.pack.sky) {
      // The HDRI: background, and (prefiltered) image-based light for every PBR material.
      const sky = o.pack.sky;
      sky.mapping = EquirectangularReflectionMapping;
      const pmrem = new PMREMGenerator(this.renderer);
      this.envTarget = pmrem.fromEquirectangular(sky);
      pmrem.dispose();
      this.scene.background = sky;
      this.scene.environment = this.envTarget.texture;
      this.scene.environmentIntensity = 0.85;
      this.scene.backgroundIntensity = 0.85;
      this.scene.fog = new FogExp2(0xc4c2bb, 0.0085);
      this.hemi = new HemisphereLight(0xd6e2f2, 0x6a5f52, 0.45);
      this.sun = new DirectionalLight(0xffd3a0, 3.3);
    } else {
      this.scene.background = new Color(map.sky.horizon);
      this.scene.fog = new Fog(map.sky.fog, 35, t.far);
      this.hemi = new HemisphereLight(0xe2ecff, 0xc9b08a, 2.1);
      this.sun = new DirectionalLight(0xfff1da, 2.5);
    }
    this.scene.add(this.hemi);
    this.sun.position.copy(this.sunDir).multiplyScalar(80);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    this.configureShadows(t.shadows, t.shadowMapSize, t.shadowSoftness);
    this.world = buildWorld(map, o.pack, { shadows: t.shadows, groundPx: o.touch || o.tier === "low" ? 12 : 22, skyline: t.skyline });
    this.scene.add(this.world.group);

    const flash = flashTexture();
    const blob = softDot(0.3, "0,0,0");
    const fxTex = { streak: streakTexture(), dot: softDot(0.15), hole: holeTexture(), smoke: smokeTexture(), fire: fireTexture(), scorch: scorchTexture() };
    this.textures = [flash, blob, ...Object.values(fxTex)];
    this.kit = new AvatarKit(blob, flash);
    this.skinKit = pbr && o.pack.soldier ? new SoldierKit(o.pack.soldier, o.pack.fabric, flash) : null;
    for (const s of this.game.soldiers) this.addRig(s, t.shadows);
    this.vm = new ViewModel(flash, pbr);
    if (pbr && this.envTarget) this.vm.scene.environment = this.envTarget.texture;
    if (t.post) this.post = new PostFx(this.renderer, this.scene, this.camera, { scene: this.vm.scene, camera: this.vm.camera, visible: () => this.vmVisible });
    this.vfx = new Vfx(this.scene, fxTex, { decals: t.decals, particles: t.particles, lights: t.flashLights, ambience: t.ambience, lite: !pbr });
    if (t.ambience) this.vfx.setAmbient(map.plumes, map.fires);
    this.vfx.onDistant = () => this.audio.distant();
    this.nadeFx = new NadeFx(this.scene);
    this.game.fx = this.fx;
    this.input.attach(o.host);
    // Desktop spectators lock the mouse to look around in free camera.
    const click = () => {
      if (this.spectating() && this.freeCam && !o.touch) this.input.requestLock();
    };
    o.host.addEventListener("click", click);
    this.unclick = () => o.host.removeEventListener("click", click);
    if (this.game.spectator || !this.game.me) {
      this.watch = this.game.soldiers[0]?.id ?? null;
    }
  }

  private readonly sunDir = new Vector3();

  private addRig(s: Soldier, shadows: boolean): void {
    let rig: Rig;
    if (this.skinKit) {
      const team = this.game.teams ? (s.team ?? 0) % 2 : s.seat % 2;
      rig = { kind: "skinned", rig: new SkinnedSoldier(this.skinKit, team, this.colorOf(s), shadows) };
    } else {
      rig = { kind: "blocky", rig: new SoldierRig(this.kit, this.colorOf(s), shadows) };
    }
    this.rigs.set(s.id, rig);
    this.scene.add(rig.rig.group);
  }

  private colorOf(s: Soldier): string {
    const g = this.game;
    if (g.teams) {
      const mine = g.me?.team ?? 0;
      return s.team === mine ? TEAM_COLORS[0]! : TEAM_COLORS[1]!;
    }
    return SEAT_COLORS[s.seat % SEAT_COLORS.length]!;
  }

  /**
   * One sun shadow map fitted tightly around the playable yard (plus the
   * height of what stands in it) in the light's own frame, so every texel
   * lands on the map: ~2 cm texels at 4096 on high, ~4 cm at 2048.
   */
  private configureShadows(on: boolean, size: number, softness = 1): void {
    this.sun.castShadow = on;
    if (!on) return;
    const b = this.game.map.bounds;
    const center = new Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDir, 90);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const view = new Matrix4().lookAt(this.sun.position, center, new Vector3(0, 1, 0));
    view.setPosition(this.sun.position);
    view.invert();
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    const p = new Vector3();
    for (const x of [b.x0 - 1.5, b.x1 + 1.5]) {
      for (const z of [b.z0 - 1.5, b.z1 + 1.5]) {
        for (const y of [0, 17.5]) {
          p.set(x, y, z).applyMatrix4(view);
          x0 = Math.min(x0, p.x);
          x1 = Math.max(x1, p.x);
          y0 = Math.min(y0, p.y);
          y1 = Math.max(y1, p.y);
          z0 = Math.min(z0, p.z);
          z1 = Math.max(z1, p.z);
        }
      }
    }
    const cam = this.sun.shadow.camera;
    cam.left = x0;
    cam.right = x1;
    cam.top = y1;
    cam.bottom = y0;
    cam.near = Math.max(0.5, -z1 - 5);
    cam.far = -z0 + 5;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = softness;
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    cam.updateProjectionMatrix();
  }

  setOverlay(o: Partial<Overlay>): void {
    this.overlay = { ...this.overlay, ...o };
    this.mapImage = null;
  }

  onCallout(fn: (c: Callout) => void): () => void {
    this.callouts.add(fn);
    return () => this.callouts.delete(fn);
  }

  private call(c: Callout): void {
    this.callouts.forEach((f) => f(c));
  }

  setTier(tier: Tier): void {
    if (tier === this.tier) return;
    const prev = TIERS[this.tier];
    const t = TIERS[tier];
    this.tier = tier;
    const dpr = Math.min(window.devicePixelRatio || 1, t.dpr);
    this.governor.setRange(dpr, Math.min(dpr, t.minDpr));
    this.renderer.setPixelRatio(this.governor.ratio);
    this.renderer.setSize(this.width, this.height, false);
    if (this.scene.fog instanceof Fog) this.scene.fog.far = t.far;
    this.world.setSkyline(t.skyline);
    this.vfx.setBudget(t.particles);
    if (t.post && !this.post) {
      this.post = new PostFx(this.renderer, this.scene, this.camera, { scene: this.vm.scene, camera: this.vm.camera, visible: () => this.vmVisible });
      this.post.setSize(this.width, this.height);
    } else if (!t.post && this.post) {
      this.post.dispose();
      this.post = null;
    }
    this.renderer.toneMapping = this.post ? NoToneMapping : ACESFilmicToneMapping;
    if (prev.shadows !== t.shadows || prev.shadowMapSize !== t.shadowMapSize) {
      this.renderer.shadowMap.enabled = t.shadows;
      this.configureShadows(t.shadows, t.shadowMapSize, t.shadowSoftness);
      this.world.setShadows(t.shadows);
      this.rigs.forEach((r) => r.rig.setShadows(t.shadows));
      this.scene.traverse((o) => {
        const m = (o as { material?: { needsUpdate: boolean } }).material;
        if (m) m.needsUpdate = true;
      });
    }
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.post?.setSize(this.width, this.height);
    const aspect = this.width / this.height;
    const need = (2 * Math.atan(Math.tan(27 * DEG) / aspect)) / DEG;
    this.fovScale = Math.tan((Math.max(BASE_FOV, need) * DEG) / 2) / Math.tan((BASE_FOV * DEG) / 2);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.vm.resize(aspect);
  }

  start(): void {
    this.last = performance.now();
    this.startedAt = this.last;
    this.audio.resume();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now, true);
    };
    this.raf = requestAnimationFrame(loop);
    // In a background tab rAF stops: keep simulating (bots, the clock, the network) at a slow tick.
    const vis = () => {
      if (document.hidden && !this.hiddenTimer) {
        this.hiddenTimer = setInterval(() => this.frame(performance.now(), false), 100);
      } else if (!document.hidden && this.hiddenTimer) {
        clearInterval(this.hiddenTimer);
        this.hiddenTimer = null;
        this.last = performance.now();
      }
    };
    document.addEventListener("visibilitychange", vis);
    this.unvis = () => document.removeEventListener("visibilitychange", vis);
    vis();
  }

  private unvis: (() => void) | null = null;
  private unclick: (() => void) | null = null;

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    const now = performance.now();
    if (paused) this.pausedAt = now;
    else if (this.game.solo) this.game.shiftClock(now - this.pausedAt);
    this.paused = paused;
    this.input.release();
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  private frame(now: number, render: boolean): void {
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(1 / 20, Math.max(0, rawDt));
    const g = this.game;
    const me = g.me;
    const settings = this.opts.settings();
    // Solo practice pauses for real; with other people the world keeps going.
    const frozen = this.paused && g.solo;

    let look: { yaw: number; pitch: number } | null = null;
    let intent: Intent | null = null;
    if (me && me.alive && g.phase === "live" && !this.paused && (this.input.locked || this.opts.touch)) {
      const w = g.weapon(me);
      const zoom = Math.tan((this.fov * DEG) / 2) / Math.tan((BASE_FOV * DEG) / 2);
      const d = this.input.sample(this.intent, settings.sensitivity, settings.invert, zoom, me.slot);
      intent = this.intent;
      if (this.opts.touch && settings.aimAssist) this.aimAssist(me, w, d, intent, dt);
      look = { yaw: d.dYaw, pitch: d.dPitch };
      this.lookX = d.dYaw;
      this.lookY = d.dPitch;
    } else {
      // Drain input we don't use (the free camera reads it itself when it places the camera).
      if (!(this.spectating() && this.freeCam)) this.input.sample(this.intent, 0, false, 1, me?.slot ?? 0);
      this.lookX = 0;
      this.lookY = 0;
    }

    if (!frozen) g.update(dt, now, intent, look);
    if (!render) return;

    const ratio = this.governor.sample(rawDt);
    if (ratio !== null) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.width, this.height, false);
      this.post?.setSize(this.width, this.height);
    }
    this.placeCamera(now, dt);
    for (const s of g.soldiers) {
      const r = this.rigs.get(s.id);
      if (!r) continue;
      // An empty seat's soldier isn't in the match: never drawn.
      const firstPerson = s.vacant || (s.isMe && !this.spectating() && (s.alive || !this.deathCam));
      if (r.kind === "skinned") r.rig.update(s, now, frozen ? 0 : dt, firstPerson, g.weapon(s).id, s.local ? g.isReloading(s, now) : !!(s.view.flags & F_RELOAD));
      else r.rig.update(s, now, dt, firstPerson);
    }
    this.vfx.update(frozen ? 0 : dt, this.camera);
    this.updateNades(now);
    this.world.update(now / 1000);
    this.updateViewModel(now, dt);
    if (me && me.alive) this.audio.setListener(me.body.x, me.body.z, me.yaw);
    else this.audio.setListener(this.camera.position.x, this.camera.position.z, this.cameraYaw());

    this.renderer.info.reset();
    this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    if (this.post) {
      this.post.render(dt, now / 1000, this.flashAmount);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      if (this.vmVisible) {
        this.renderer.clearDepth();
        this.renderer.render(this.vm.scene, this.vm.camera);
      }
    }
    this.drawOverlays(now);
  }

  private vmVisible = false;

  private spectating(): boolean {
    return !this.game.me;
  }

  private cameraYaw(): number {
    this.camera.getWorldDirection(_v);
    return Math.atan2(-_v.x, -_v.z);
  }

  private placeCamera(now: number, dt: number): void {
    const g = this.game;
    const me = g.me;
    const cam = this.camera;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.landDip += (0 - this.landDip) * Math.min(1, dt * 10);
    this.punch += (0 - this.punch) * Math.min(1, dt * 16);
    const reduce = this.opts.reduceMotion ? 0.35 : 1;
    const shake = this.trauma * this.trauma * reduce;
    const sx = (Math.sin(now * 0.041) + Math.sin(now * 0.073)) * 0.5 * shake * 0.035;
    const sy = (Math.sin(now * 0.053) + Math.sin(now * 0.029)) * 0.5 * shake * 0.035;

    if (me && me.alive) {
      this.deathCam = null;
      const eye = me.body.y + g.eyeHeight(me) + me.eyeOffset + this.landDip;
      const bob = me.body.grounded ? Math.abs(Math.sin(me.walkPhase * Math.PI)) * 0.035 * Math.min(1, me.speed / RUN_SPEED) * (1 - me.ads * 0.8) * reduce : 0;
      cam.position.set(me.body.x, eye + bob, me.body.z);
      cam.rotation.set(me.pitch + this.punch + sy, me.yaw + sx, 0, "YXZ");
      const w = g.weapon(me);
      const target = BASE_FOV + (w.adsFov - BASE_FOV) * me.ads + (me.sprinting ? 5 : 0);
      this.fov += (target - this.fov) * Math.min(1, dt * 14);
      return this.setFov(this.fov);
    }
    if (me && !me.alive) {
      // Death cam: sink to the ground and turn toward whoever did it.
      if (!this.deathCam) this.deathCam = { x: me.body.x, y: me.body.y + g.eyeHeight(me), z: me.body.z, yaw: me.yaw, pitch: me.pitch, at: now };
      const d = this.deathCam;
      const k = Math.min(1, (now - d.at) / 700);
      const killer = me.killedBy ? g.bySeat.get(me.killedBy.seat) : undefined;
      let yaw = d.yaw;
      let pitch = d.pitch * (1 - k);
      if (killer && killer !== me) {
        const p = g.posOf(killer);
        const dx = p.x - d.x;
        const dz = p.z - d.z;
        const targetYaw = Math.atan2(-dx, -dz);
        let dy = targetYaw - d.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        const kk = Math.min(1, Math.max(0, (now - d.at - 300) / 900));
        yaw = d.yaw + dy * easeInOut(kk);
        pitch = Math.atan2(p.y + 1.2 - (d.y - 1.1 * k), Math.hypot(dx, dz)) * easeInOut(kk);
      }
      cam.position.set(d.x, d.y - 1.1 * easeInOut(k), d.z);
      cam.rotation.set(pitch, yaw, 0.14 * easeInOut(k), "YXZ");
      this.fov += (BASE_FOV - this.fov) * Math.min(1, dt * 8);
      return this.setFov(this.fov);
    }
    // Spectators: follow a player over the shoulder, or fly free.
    if (this.freeCam) {
      const f = this.free;
      const d = this.input.sample(this.intent, 2.2, false, 1, 0);
      f.yaw += d.dYaw;
      f.pitch = Math.max(-1.4, Math.min(1.4, f.pitch + d.dPitch));
      const speed = (this.intent.sprint ? 22 : 11) * dt;
      viewDir(f.yaw, f.pitch, _v as unknown as Vec3);
      const rx = Math.cos(f.yaw);
      const rz = -Math.sin(f.yaw);
      f.x += (_v.x * this.intent.forward + rx * this.intent.strafe) * speed;
      f.y = Math.max(1, Math.min(40, f.y + _v.y * this.intent.forward * speed + (this.intent.jump ? 2 : 0)));
      f.z += (_v.z * this.intent.forward + rz * this.intent.strafe) * speed;
      cam.position.set(f.x, f.y, f.z);
      cam.rotation.set(f.pitch, f.yaw, 0, "YXZ");
      return this.setFov(BASE_FOV);
    }
    let target = this.watch ? g.byId.get(this.watch) : undefined;
    if (!target || (!target.alive && now - target.diedAt > 2500)) {
      target = g.soldiers.find((s) => s.alive) ?? target;
      if (target) this.watch = target.id;
    }
    if (!target) return this.setFov(BASE_FOV);
    const p = target.body;
    const eyeY = p.y + g.eyeHeight(target);
    viewDir(target.yaw, Math.max(-0.5, Math.min(0.5, target.pitch)), _w as unknown as Vec3);
    const rx = Math.cos(target.yaw);
    const rz = -Math.sin(target.yaw);
    let back = 3.2;
    const want = { x: p.x - _w.x * back + rx * 0.7, y: eyeY + 0.5 - _w.y * back, z: p.z - _w.z * back + rz * 0.7 };
    const dx = want.x - p.x;
    const dy = want.y - eyeY;
    const dz = want.z - p.z;
    const len = Math.hypot(dx, dy, dz);
    const hit = raycastMap(g.world, p.x, eyeY, p.z, dx / len, dy / len, dz / len, len);
    if (hit) back = Math.max(0.4, hit.t - 0.3);
    const k = Math.min(1, back / len);
    cam.position.lerp(_v.set(p.x + dx * k, eyeY + dy * k, p.z + dz * k), Math.min(1, dt * 10));
    cam.rotation.set(target.pitch * 0.6, target.yaw, 0, "YXZ");
    return this.setFov(BASE_FOV);
  }

  /** `fov` is the design (landscape) vertical FOV; tall screens get it widened by `fovScale`. */
  private setFov(fov: number): void {
    const actual = (2 * Math.atan(Math.tan((fov * DEG) / 2) * this.fovScale)) / DEG;
    if (Math.abs(this.camera.fov - actual) < 0.01) return;
    this.camera.fov = actual;
    this.camera.updateProjectionMatrix();
  }

  private updateViewModel(now: number, dt: number): void {
    const g = this.game;
    const me = g.me;
    if (!me || !me.alive || g.phase === "over") {
      this.vmVisible = false;
      return;
    }
    const w = g.weapon(me);
    this.vm.setWeapon(w.id);
    const reload = me.reloadUntil > now ? (now - me.reloadStart) / Math.max(1, me.reloadUntil - me.reloadStart) : -1;
    const swap = me.swapUntil > now ? (now - me.swapStart) / Math.max(1, me.swapUntil - me.swapStart) : -1;
    const scoped = w.scope && me.ads > 0.85;
    this.vm.update({
      now,
      dt,
      ads: me.ads,
      sprinting: me.sprinting,
      moving: Math.min(1, me.speed / RUN_SPEED),
      walkPhase: me.walkPhase,
      grounded: me.body.grounded,
      lookX: this.lookX,
      lookY: this.lookY,
      reload,
      swap,
      strafe: this.intent.strafe,
      nadeHeld: me.nadeHeld && me.nades > 0,
      hideScoped: scoped,
      reduceMotion: this.opts.reduceMotion,
    });
    this.vmVisible = !scoped;
  }

  /* ---------------------------------------------------------------------- */
  /* Aim assist (touch)                                                     */
  /* ---------------------------------------------------------------------- */

  /** The enemy closest to the crosshair (angle), if any is visible within ~6°. */
  private nearestToCrosshair(me: Soldier, maxAngle: number): { s: Soldier; angle: number; yawOff: number; pitchOff: number; dist: number; onTarget: boolean } | null {
    const g = this.game;
    const eye = { x: me.body.x, y: me.body.y + g.eyeHeight(me), z: me.body.z };
    const f = viewDir(me.yaw, me.pitch);
    let best: { s: Soldier; angle: number; yawOff: number; pitchOff: number; dist: number; onTarget: boolean } | null = null;
    for (const o of g.soldiers) {
      if (o === me || !g.targetable(o) || !g.isEnemy(me, o)) continue;
      const p = g.posOf(o);
      const chest = { x: p.x, y: p.y + (g.crouchOf(o) > 0.5 ? 0.8 : 1.2), z: p.z };
      const dx = chest.x - eye.x;
      const dy = chest.y - eye.y;
      const dz = chest.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 70) continue;
      const cos = (dx * f.x + dy * f.y + dz * f.z) / dist;
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle > maxAngle || (best && angle >= best.angle)) continue;
      if (!lineOfSight(g.world, eye, chest, 0.2)) continue;
      let yawOff = Math.atan2(-dx, -dz) - me.yaw;
      while (yawOff > Math.PI) yawOff -= Math.PI * 2;
      while (yawOff < -Math.PI) yawOff += Math.PI * 2;
      const pitchOff = Math.atan2(dy, Math.hypot(dx, dz)) - me.pitch;
      const hit = rayPlayer(eye.x, eye.y, eye.z, f.x, f.y, f.z, dist + 1, { x: p.x, y: p.y, z: p.z, crouch: g.crouchOf(o) });
      best = { s: o, angle, yawOff, pitchOff, dist, onTarget: !!hit };
    }
    return best;
  }

  private aimAssist(me: Soldier, w: WeaponDef, d: { dYaw: number; dPitch: number }, intent: Intent, dt: number): void {
    // Light friction only: your look slows a little while the crosshair is on or
    // right next to an enemy. No pull toward them and no auto-fire: you aim and
    // you shoot.
    void w;
    void intent;
    void dt;
    const t = this.nearestToCrosshair(me, 2.5 * DEG);
    if (!t) return;
    const k = t.onTarget ? 0.72 : 0.85;
    d.dYaw *= k;
    d.dPitch *= k;
  }

  /* ---------------------------------------------------------------------- */
  /* Effects                                                                */
  /* ---------------------------------------------------------------------- */

  private muzzleOf(s: Soldier, origin: Vec3): Vec3 {
    const f = viewDir(s.yaw, s.pitch);
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    if (s.isMe && !this.spectating()) {
      const ads = s.ads;
      return { x: origin.x + f.x * 0.7 + rx * 0.12 * (1 - ads), y: origin.y + f.y * 0.7 - 0.12 * (1 - ads) - 0.04, z: origin.z + f.z * 0.7 + rz * 0.12 * (1 - ads) };
    }
    return { x: origin.x + f.x * 0.85 + rx * 0.08, y: origin.y + f.y * 0.85 - 0.28, z: origin.z + f.z * 0.85 + rz * 0.08 };
  }

  /** Live grenades (meshes, bounce clinks) and, while you hold G, the throw arc. */
  private updateNades(now: number): void {
    const g = this.game;
    const me = g.me;
    const aiming = !!me && me.alive && me.nadeHeld && me.nades > 0 && g.phase === "live";
    this.nadeFx.update(g, now, aiming && me ? g.previewNade(me) : null, (x, z) => this.audio.clink(x, z));
  }

  private readonly fx: GameFx = {
    nade: (n) => {
      const s = this.game.bySeat.get(n.thrower);
      const mine = !!s?.isMe && !this.spectating();
      if (s) this.audio.throwNade(s.body.x, s.body.z, mine);
      if (mine) this.vm.throwNade(performance.now());
    },
    explosion: (n) => {
      const p = n.flight.end;
      this.vfx.explosion(p.x, p.y, p.z);
      this.audio.explosion(p.x, p.z);
      const d = this.camera.position.distanceTo(_v.set(p.x, p.y, p.z));
      this.trauma = Math.min(1, this.trauma + Math.max(0, 1.1 - d / 18));
      this.flashAmount = Math.max(this.flashAmount, Math.max(0, 0.5 - d / 30));
      if (d < 9) this.audio.muffle(0.7 * (1 - d / 9), 1.2);
      if (d < 12) this.opts.haptic(d < 6 ? "heavy" : "medium");
    },
    shot: (s: Soldier, w: WeaponDef, origin: Vec3, ends: readonly Vec3[], impacts: readonly Impact[]) => {
      const mine = s.isMe && !this.spectating();
      const r = this.rigs.get(s.id);
      const muzzle = !mine && r?.kind === "skinned" && r.rig.group.visible ? r.rig.muzzleWorld(_w) : this.muzzleOf(s, origin);
      const mx = muzzle.x;
      const my = muzzle.y;
      const mz = muzzle.z;
      // Muzzle light, a wisp of smoke, and a spent case (not for the shotgun's pump, not every SMG round).
      const camD = Math.hypot(mx - this.camera.position.x, mz - this.camera.position.z);
      if (camD < 45) {
        this.vfx.flash(mx, my, mz, mine ? 3.5 : 5, 55, 0xffb266);
        this.vfx.muzzleSmoke(mx, my, mz, w.id === "shotgun" || w.id === "sniper");
        if (w.id !== "shotgun" && (w.id !== "smg" || s.shotSeq % 2 === 0)) {
          const rx = Math.cos(s.yaw);
          const rz = -Math.sin(s.yaw);
          const f = viewDir(s.yaw, s.pitch);
          const ex = mine ? this.camera.position.x + rx * 0.16 + f.x * 0.35 : mx - f.x * 0.45;
          const ey = mine ? this.camera.position.y - 0.1 : my;
          const ez = mine ? this.camera.position.z + rz * 0.16 + f.z * 0.35 : mz - f.z * 0.45;
          this.vfx.casing(ex, ey, ez, rx, rz, w.id === "sniper");
        }
      }
      const every = mine ? (w.pellets > 1 ? 3 : 2) : w.pellets > 1 ? 3 : 1;
      ends.forEach((e, i) => {
        if (i % every === 0 && (!mine || s.shotSeq % 2 === 0 || w.pellets > 1)) this.vfx.tracer(muzzle, e, w.id === "sniper" ? 0.06 : 0.035);
      });
      for (const i of impacts) {
        this.vfx.impact(i);
        if (i.surface !== "flesh") this.audio.impact(i.x, i.z, i.surface === "metal" || i.surface === "container");
      }
      this.audio.gunshot(w.id, s.body.x, s.body.z, mine);
      if (mine) {
        const strength = w.id === "sniper" || w.id === "shotgun" ? 2.2 : w.id === "pistol" ? 1.1 : 0.8;
        this.vm.fired(performance.now(), strength);
        this.trauma = Math.min(1, this.trauma + (w.id === "sniper" || w.id === "shotgun" ? 0.45 : 0.12));
        this.punch += (w.recoilPitch * DEG) * 0.4;
      }
    },
    hitMarker: (kind) => {
      if (kind === "kill") {
        this.hitKind = "kill";
      } else if (this.hitKind !== "kill" || performance.now() - this.hitAt > 300) {
        this.hitKind = kind;
      }
      this.hitAt = performance.now();
      if (kind === "kill") {
        this.audio.kill();
        this.opts.haptic("success");
      } else {
        this.audio.hit(kind === "head");
        this.opts.haptic("light");
      }
    },
    hurt: (from: Vec3, damage: number) => {
      const now = performance.now();
      this.arrows.push({ x: from.x, z: from.z, at: now });
      if (this.arrows.length > 4) this.arrows.shift();
      this.hurtAt = now;
      this.trauma = Math.min(1, this.trauma + 0.25 + damage / 150);
      this.punch -= 0.02;
      this.audio.hurt(damage);
      if (damage >= 40) this.audio.muffle(0.5, 0.6);
      this.opts.haptic(damage >= 40 ? "heavy" : "medium");
    },
    kill: (entry: FeedEntry, mine: "killer" | "victim" | null) => {
      const g = this.game;
      if (mine === "killer") {
        const victim = g.bySeat.get(entry.victim);
        this.call({ kind: "kill", name: victim?.name ?? "Enemy", headshot: entry.headshot, streak: g.me?.streak ?? 0 });
        if (g.log.firstBlood && g.log.kills === 1 && g.feed.length === 1) this.call({ kind: "first_blood" });
      } else if (mine === "victim") {
        this.audio.died();
        this.input.release();
        this.opts.haptic("heavy");
      }
    },
    spawned: (s: Soldier) => {
      if (s.isMe) {
        this.audio.spawn();
        this.deathCam = null;
        this.arrows.length = 0;
        this.call({ kind: "spawn" });
      }
    },
    landed: (s: Soldier, speed: number) => {
      if (s.isMe) {
        this.landDip = -Math.min(0.18, speed * 0.018);
        this.audio.land();
      }
      if (speed > 6) this.vfx.dust(s.body.x, s.body.y, s.body.z, 4);
    },
    step: (s: Soldier) => {
      if (!s.isMe && Math.hypot(s.body.x - this.camera.position.x, s.body.z - this.camera.position.z) > 32) return;
      this.audio.footstep(s.body.x, s.body.z, s.isMe && !this.spectating(), s.loadout.perk === "light_step" || s.crouch > 0.5);
    },
    reload: (s: Soldier) => {
      if (!s.isMe) return;
      const w = this.game.weapon(s);
      this.audio.reload((s.reloadUntil - s.reloadStart) / 1000, w.id);
    },
    swap: (s: Soldier) => {
      if (s.isMe) this.audio.swap();
    },
    dry: (s: Soldier) => {
      if (s.isMe) this.audio.dry();
    },
    streak: (kind) => {
      if (kind === "radar") {
        this.audio.radar();
        this.call({ kind: "radar" });
        this.opts.haptic("success");
      }
    },
  };

  /* ---------------------------------------------------------------------- */
  /* Overlays                                                               */
  /* ---------------------------------------------------------------------- */

  private drawOverlays(now: number): void {
    const g = this.game;
    const me = g.me;
    const o = this.overlay;
    const alive = !!me && me.alive && g.phase === "live";
    const w = me ? g.weapon(me) : null;

    // Crosshair: four ticks that spread with the real cone.
    if (o.crosshair) {
      if (!alive || !w || !me) o.crosshair.style.opacity = "0";
      else {
        const spread =
          spreadDeg(w, {
            ads: me.ads,
            speed: me.speed / RUN_SPEED,
            airborne: !me.body.grounded,
            crouched: me.crouch > 0.5,
            bloom: me.bloom,
            steadyAim: me.loadout.perk === "steady_aim",
          }) + (w.pellets > 1 ? w.pelletSpread * 0.8 : 0);
        const px = (Math.tan(spread * DEG) / Math.tan((this.camera.fov * DEG) / 2)) * (this.height / 2);
        const gap = Math.max(3, Math.min(90, px));
        const hide = me.sprinting ? 1 : w.scope ? me.ads : w.pellets > 1 ? 0 : Math.max(0, me.ads * 1.6 - 0.6);
        o.crosshair.style.opacity = String(Math.max(0, 1 - hide) * (g.isReloading(me, now) ? 0.5 : 1));
        o.crosshair.style.setProperty("--gap", `${gap.toFixed(1)}px`);
      }
    }

    // Hit marker.
    if (o.hitmarker) {
      const age = now - this.hitAt;
      const life = this.hitKind === "kill" ? 420 : 240;
      const k = Math.max(0, 1 - age / life);
      o.hitmarker.style.opacity = k.toFixed(3);
      o.hitmarker.dataset.kind = this.hitKind;
      const scale = this.hitKind === "kill" ? 1.25 + (1 - k) * 0.3 : 1 + (1 - k) * 0.25;
      o.hitmarker.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }

    // Damage direction arrows around the crosshair.
    const yaw = me ? me.yaw : this.cameraYaw();
    for (let i = 0; i < o.damage.length; i++) {
      const el = o.damage[i]!;
      const a = this.arrows[i];
      if (!a || !me || now - a.at > 1600) {
        el.style.opacity = "0";
        continue;
      }
      const bearing = Math.atan2(-(a.x - me.body.x), -(a.z - me.body.z)) - yaw;
      el.style.opacity = Math.max(0, 1 - (now - a.at) / 1600).toFixed(3);
      el.style.transform = `translate(-50%, -50%) rotate(${(-bearing).toFixed(3)}rad)`;
    }

    // Vignette: recent damage + low health.
    if (o.vignette) {
      const hurt = Math.max(0, 1 - (now - this.hurtAt) / 700);
      const low = me && me.alive ? Math.max(0, (45 - me.hp) / 45) : 0;
      const pulse = low > 0 ? 0.08 * Math.sin(now / 220) : 0;
      o.vignette.style.opacity = Math.min(1, hurt * 0.55 + low * 0.75 + pulse).toFixed(3);
    }

    // Sniper scope.
    if (o.scope) {
      const scoped = !!me && alive && !!w && w.scope && me.ads > 0.85;
      o.scope.style.opacity = scoped ? "1" : "0";
    }

    // Enemy name when the crosshair is on them.
    if (o.nametag) {
      const t = alive && me ? this.nearestToCrosshair(me, 3 * DEG) : null;
      if (t && t.onTarget) {
        o.nametag.textContent = t.s.name;
        o.nametag.style.opacity = "1";
        o.crosshair?.setAttribute("data-enemy", "1");
      } else {
        o.nametag.style.opacity = "0";
        o.crosshair?.removeAttribute("data-enemy");
      }
    }

    this.updateNpcTags(me);

    // Compass: heading strip.
    if (o.compass) {
      const heading = -this.cameraYaw();
      o.compass.style.setProperty("--heading", heading.toFixed(4));
    }

    // Minimap at ~15 Hz.
    if (o.minimap && now - this.minimapAt > 66) {
      this.minimapAt = now;
      this.drawMinimap(o.minimap, now);
    }
  }

  private drawMinimap(c: HTMLCanvasElement, now: number): void {
    const g = this.game;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const size = c.width;
    const ppm = size / 44; // ~44 m across
    if (!this.mapImage) this.mapImage = renderMapImage(g, 6);
    const me = g.me;
    const center = me && me.alive ? me.body : this.camera.position;
    const yaw = me && me.alive ? me.yaw : this.cameraYaw();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "rgba(20,22,18,0.72)";
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.rotate(yaw);
    const b = g.map.bounds;
    const s = ppm / 6;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.mapImage, (b.x0 - center.x) * ppm, (b.z0 - center.z) * ppm, this.mapImage.width * s, this.mapImage.height * s);
    ctx.globalAlpha = 1;
    const radar = !!me && me.radarUntil > now;
    if (radar) {
      // Sweep.
      const a = ((now / 900) % 1) * Math.PI * 2;
      const grad = ctx.createConicGradient?.(a - 0.8, 0, 0);
      if (grad) {
        grad.addColorStop(0, "rgba(120,255,160,0)");
        grad.addColorStop(0.12, "rgba(120,255,160,0.28)");
        grad.addColorStop(0.125, "rgba(120,255,160,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(-size, -size, size * 2, size * 2);
      }
    }
    for (const o of g.soldiers) {
      if (!o.alive || o === me) continue;
      const friend = !!me && !g.isEnemy(me, o);
      const loud = now - o.lastShotFx < 1400 && o.loadout.perk !== "light_step";
      if (me && !friend && !radar && !loud) continue;
      const x = (o.body.x - center.x) * ppm;
      const z = (o.body.z - center.z) * ppm;
      ctx.fillStyle = !me ? "#ffd166" : friend ? "#58b7ff" : "#ff4d3d";
      ctx.beginPath();
      ctx.arc(x, z, friend ? 3.2 : 3.6, 0, Math.PI * 2);
      ctx.fill();
      if (!friend && loud && !radar) {
        ctx.strokeStyle = `rgba(255,77,61,${(1 - (now - o.lastShotFx) / 1400).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, z, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    // You: an arrow at the center pointing up.
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2 - 6);
    ctx.lineTo(size / 2 + 4.5, size / 2 + 5);
    ctx.lineTo(size / 2, size / 2 + 2.5);
    ctx.lineTo(size / 2 - 4.5, size / 2 + 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = radar ? "rgba(120,255,160,0.8)" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Spectators: cycle who the camera follows. */
  watchNext(): void {
    const list = this.game.soldiers.filter((s) => s.alive);
    const all = list.length ? list : this.game.soldiers.filter((s) => !s.vacant);
    const i = all.findIndex((s) => s.id === this.watch);
    this.watch = all[(i + 1) % all.length]?.id ?? null;
    this.freeCam = false;
  }

  toggleFreeCam(): void {
    this.freeCam = !this.freeCam;
    if (this.freeCam) {
      this.free.x = this.camera.position.x;
      this.free.y = Math.max(3, this.camera.position.y);
      this.free.z = this.camera.position.z;
      this.free.yaw = this.cameraYaw();
    }
  }

  get elapsed(): number {
    return performance.now() - this.startedAt;
  }

  /** An "NPC" tag over each bot you can see, so nobody mistakes it for a person. */
  private updateNpcTags(me: Soldier | null): void {
    const g = this.game;
    const cam = this.camera;
    const from = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
    for (const s of g.soldiers) {
      let tag = this.npcTags.get(s.id);
      const show = s.isBot && !s.vacant && s !== me && g.targetable(s) && !this.paused;
      if (!show) {
        if (tag) tag.style.opacity = "0";
        continue;
      }
      const p = g.posOf(s);
      const head = { x: p.x, y: p.y + (g.crouchOf(s) > 0.5 ? 1.45 : 2.05), z: p.z };
      _v.set(head.x, head.y, head.z).project(cam);
      const onScreen = _v.z > -1 && _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
      // Only where you could see the bot itself: no tags through walls.
      if (!onScreen || !lineOfSight(g.world, from, head, 0.1)) {
        if (tag) tag.style.opacity = "0";
        continue;
      }
      if (!tag) {
        tag = document.createElement("div");
        tag.textContent = "NPC";
        tag.className =
          "pointer-events-none absolute left-0 top-0 z-10 rounded-md bg-black/55 px-1.5 py-px text-[10px] font-black tracking-widest text-[#ffd166] ring-1 ring-[#ffd166]/50 transition-opacity duration-150";
        this.opts.host.appendChild(tag);
        this.npcTags.set(s.id, tag);
      }
      const dist = Math.hypot(head.x - from.x, head.y - from.y, head.z - from.z);
      const x = ((_v.x + 1) / 2) * this.width;
      const y = ((1 - _v.y) / 2) * this.height;
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${Math.max(0.7, Math.min(1.15, 14 / Math.max(1, dist))).toFixed(2)})`;
      tag.style.opacity = "1";
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const tag of this.npcTags.values()) tag.remove();
    this.npcTags.clear();
    cancelAnimationFrame(this.raf);
    if (this.hiddenTimer) clearInterval(this.hiddenTimer);
    this.unvis?.();
    this.unclick?.();
    this.game.fx = null;
    this.input.dispose();
    this.audio.dispose();
    this.vfx.dispose();
    this.nadeFx.dispose();
    this.vm.dispose();
    this.world.dispose();
    this.kit.dispose();
    this.rigs.forEach((r) => r.rig.dispose());
    this.skinKit?.dispose();
    this.post?.dispose();
    this.envTarget?.dispose();
    this.sun.shadow.map?.dispose();
    this.textures.forEach((t) => t.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Top-down picture of the map for the minimap (`ppm` px per meter). */
function renderMapImage(g: Game, ppm: number): HTMLCanvasElement {
  const b = g.map.bounds;
  const c = document.createElement("canvas");
  c.width = Math.round((b.x1 - b.x0) * ppm);
  c.height = Math.round((b.z1 - b.z0) * ppm);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(210,196,170,0.2)";
  ctx.fillRect(0, 0, c.width, c.height);
  const boxes = [...g.map.boxes].filter((x) => !x.ghost && x.y1 > 0.5 && x.y0 < 2.5).sort((a, b2) => a.y1 - b2.y1);
  for (const x of boxes) {
    const h = Math.min(1, x.y1 / 5.5);
    const v = Math.round(120 + h * 110);
    ctx.fillStyle = `rgb(${v},${v - 4},${v - 14})`;
    ctx.fillRect((x.x0 - b.x0) * ppm, (x.z0 - b.z0) * ppm, (x.x1 - x.x0) * ppm, (x.z1 - x.z0) * ppm);
  }
  return c;
}
