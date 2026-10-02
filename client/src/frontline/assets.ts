/**
 * Downloaded assets per quality level (all CC0, see
 * public/first-party/frontline/CREDITS.md):
 *
 *   lo   512 px albedo textures only (~0.17 MB): the cheap Lambert world
 *   mid  1K PBR sets (albedo + normal + AO/rough/metal), the HDRI sky, the
 *        animated soldier (~4.5 MB)
 *   hi   mid, with the containers and the asphalt at 2K (~8 MB)
 *
 * Loads once per page (module cache) with progress, and starts as early as
 * the loadout screen so a match rarely waits. The CPU-side objects are kept;
 * each engine uploads them to its own GL context and frees them on dispose
 * (three re-uploads a disposed texture the next time it's drawn).
 */

import { DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, type AnimationClip, type DataTexture, type Group, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { AssetLevel } from "./quality";

const BASE = "/first-party/frontline";

/** Tiled PBR materials. `painted` carries a paint mask in albedo alpha (1 = paint, 0 = rust). */
export const MATERIALS = ["container", "asphalt", "concrete", "planks", "painted", "plate", "cladding"] as const;
export type MaterialId = (typeof MATERIALS)[number];

export interface MaterialMaps {
  albedo: Texture;
  normal: Texture | null;
  /** AO (r), roughness (g), metalness (b). */
  arm: Texture | null;
}

export interface SoldierAsset {
  scene: Group;
  clips: AnimationClip[];
}

export interface AssetPack {
  level: AssetLevel;
  mats: Record<MaterialId, MaterialMaps>;
  /** Container rust streaks and dirt: rgb color, a amount (u along the side, v up); mid/hi. */
  grime: Texture | null;
  /** Tarp weave normal (mid/hi). */
  fabric: Texture | null;
  /** Equirect HDR sky (mid/hi). */
  sky: DataTexture | null;
  soldier: SoldierAsset | null;
}

interface Job {
  weight: number;
  run: () => Promise<void>;
}

const HI_2K: readonly MaterialId[] = ["container", "asphalt"];

function dirFor(level: AssetLevel, id: MaterialId | "grime"): string {
  if (level === "lo") return "lo";
  if (level === "hi" && (id === "grime" || HI_2K.includes(id as MaterialId))) return "hi";
  return "mid";
}

function setup(t: Texture, color: boolean): Texture {
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  if (color) t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  return t;
}

const cache = new Map<AssetLevel, Promise<AssetPack>>();
const progressOf = new Map<AssetLevel, number>();
const listeners = new Set<() => void>();

/** 0…1 download progress of a level (1 when loaded). */
export function assetProgress(level: AssetLevel): number {
  return progressOf.get(level) ?? 0;
}

export function onAssetProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Starts (or joins) loading a level's assets. */
export function loadAssets(level: AssetLevel): Promise<AssetPack> {
  let p = cache.get(level);
  if (!p) {
    p = load(level);
    cache.set(level, p);
    // A failed load can be retried later (e.g. a flaky network).
    p.catch(() => cache.delete(level));
  }
  return p;
}

async function load(level: AssetLevel): Promise<AssetPack> {
  const tl = new TextureLoader();
  const jobs: Job[] = [];
  const mats = {} as Record<MaterialId, MaterialMaps>;
  const tex = (path: string, color: boolean, weight = 1) => {
    let out: Texture | null = null;
    jobs.push({
      weight,
      run: async () => {
        out = setup(await tl.loadAsync(`${BASE}/${path}`), color);
      },
    });
    return () => out!;
  };
  const pending: [MaterialId, () => Texture, (() => Texture) | null, (() => Texture) | null][] = [];
  for (const id of MATERIALS) {
    const dir = dirFor(level, id);
    const big = dir === "hi" ? 3 : 1;
    const albedo = tex(`${dir}/${id}_albedo.webp`, true, big);
    const normal = level === "lo" ? null : tex(`${dir}/${id}_normal.webp`, false, big);
    const arm = level === "lo" ? null : tex(`${dir}/${id}_arm.webp`, false, big);
    pending.push([id, albedo, normal, arm]);
  }
  const grime = level === "lo" ? null : tex(`${dirFor(level, "grime")}/container_grime.webp`, true);
  const fabric = level === "lo" ? null : tex("mid/fabric_normal.webp", false);
  let sky: DataTexture | null = null;
  let soldier: SoldierAsset | null = null;
  if (level !== "lo") {
    jobs.push({
      weight: 3,
      run: async () => {
        const hdr = new HDRLoader().setDataType(HalfFloatType);
        sky = await hdr.loadAsync(`${BASE}/sky_1k.hdr`);
        capSky(sky, SKY_MAX);
      },
    });
    jobs.push({
      weight: 2,
      run: async () => {
        const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(`${BASE}/soldier.glb`);
        soldier = { scene: gltf.scene, clips: gltf.animations };
      },
    });
  }
  const total = jobs.reduce((n, j) => n + j.weight, 0);
  let done = 0;
  progressOf.set(level, 0);
  const tick = (w: number) => {
    done += w;
    progressOf.set(level, Math.min(0.999, done / total));
    listeners.forEach((l) => l());
  };
  // A few at a time: the big files don't starve the small ones.
  const queue = [...jobs];
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      await j.run();
      tick(j.weight);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const [id, a, n, r] of pending) mats[id] = { albedo: a(), normal: n ? n() : null, arm: r ? r() : null };
  progressOf.set(level, 1);
  listeners.forEach((l) => l());
  return { level, mats, grime: grime ? grime() : null, fabric: fabric ? fabric() : null, sky, soldier };
}

/**
 * Brightest the sky may be (linear). The HDRI's sun disc is thousands of times
 * brighter than the sky around it: the directional light already is the sun,
 * so capping the disc keeps it bright without blowing out bloom and the
 * image-based light on high.
 */
const SKY_MAX = 5;

function capSky(tex: DataTexture, max: number): void {
  const data = tex.image.data as Uint16Array;
  const cap = DataUtils.toHalfFloat(max);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) if (DataUtils.fromHalfFloat(data[i + c]!) > max) data[i + c] = cap;
  }
  tex.needsUpdate = true;
}
