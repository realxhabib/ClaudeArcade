/**
 * Builds the race track as meshes from a compiled track: the road ribbon,
 * rumble curbs and shoulders, the floating slab underneath, wall rails with
 * energy barriers, lamp posts, neon arches, boost pads, ramps and the
 * start/finish gantry (whose lights run the countdown).
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
  type Texture,
} from "three";
import { ROAD_LOOKS, paintChecker, paintChevrons, paintCurb, paintRoad, paintShoulder, paintSign } from "./textures";
import { RAMP_HEIGHT } from "./physics";
import { PAD_LENGTH, RAMP_LENGTH, frameAt, newFrame, wrapS, type CompiledTrack } from "./track";

export interface TrackView {
  group: Group;
  /** Per-frame animation (barrier shimmer near the player, pad scroll, lights). */
  update(time: number, focus: Vector3, countdown: { phase: string; t: number; length: number }): void;
  dispose(): void;
}

interface StripOpts {
  d0: (i: number) => number;
  d1: (i: number) => number;
  h0: number | ((i: number) => number);
  h1: number | ((i: number) => number);
  across: number;
  vScale: number;
  stride?: number;
  skip?: (i: number) => boolean;
  flip?: boolean;
}

/** A strip following the track: across from (d0,h0) to (d1,h1) at every sample. */
function strip(track: CompiledTrack, o: StripOpts): BufferGeometry {
  const stride = o.stride ?? 1;
  const rows = Math.ceil(track.count / stride);
  const cols = o.across + 1;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const h0 = typeof o.h0 === "number" ? () => o.h0 as number : o.h0;
  const h1 = typeof o.h1 === "number" ? () => o.h1 as number : o.h1;
  for (let r = 0; r < rows; r++) {
    const i = Math.min(track.count - 1, r * stride);
    const px = track.pos[i * 3]!;
    const py = track.pos[i * 3 + 1]!;
    const pz = track.pos[i * 3 + 2]!;
    const rx = track.right[i * 3]!;
    const ry = track.right[i * 3 + 1]!;
    const rz = track.right[i * 3 + 2]!;
    const ux = track.up[i * 3]!;
    const uy = track.up[i * 3 + 1]!;
    const uz = track.up[i * 3 + 2]!;
    const a = o.d0(i);
    const b = o.d1(i);
    const ha = h0(i);
    const hb = h1(i);
    for (let c = 0; c < cols; c++) {
      const t = c / o.across;
      const d = a + (b - a) * t;
      const h = ha + (hb - ha) * t;
      const k = (r * cols + c) * 3;
      pos[k] = px + rx * d + ux * h;
      pos[k + 1] = py + ry * d + uy * h;
      pos[k + 2] = pz + rz * d + uz * h;
      uv[(r * cols + c) * 2] = t;
      uv[(r * cols + c) * 2 + 1] = (i * track.step) / o.vScale;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    const rn = (r + 1) % rows;
    const i = Math.min(track.count - 1, r * stride);
    const j = Math.min(track.count - 1, rn * stride);
    if (o.skip && (o.skip(i) || o.skip(j))) continue;
    // The seam row wraps: keep v continuous by duplicating isn't worth it; the lap length is a multiple-ish of vScale.
    for (let c = 0; c < o.across; c++) {
      const a = r * cols + c;
      const b = rn * cols + c;
      // Along × across = −up, so the default winding is (a, a+1, b) to face up.
      if (o.flip) index.push(a, b, a + 1, b, b + 1, a + 1);
      else index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const BARRIER_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BARRIER_FS = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uFocus;
varying vec2 vUv;
varying vec3 vWorld;
float hex(vec2 p) {
  p.x *= 1.1547;
  p.y += mod(floor(p.x), 2.0) * 0.5;
  p = abs(fract(p) - 0.5);
  return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
}
void main() {
  float near = 1.0 - smoothstep(6.0, 28.0, distance(vWorld, uFocus));
  vec2 p = vec2(vUv.y * 0.9, vUv.x * 2.2);
  float h = 1.0 - smoothstep(0.0, 0.08, hex(p));
  float scan = 0.5 + 0.5 * sin(vUv.y * 1.3 - uTime * 6.0);
  float fade = (1.0 - vUv.x);
  float base = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.0, 0.35, vUv.x));
  float a = fade * (0.03 + near * 0.12) + h * fade * (0.05 + near * 0.3) + base * 0.22 + scan * 0.02 * fade;
  gl_FragColor = vec4(uColor * (0.7 + near * 0.5), a);
}`;

const PAD_FS = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform sampler2D uMap;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vec2(vUv.x, fract(vUv.y * 1.5 - uTime * 1.8)));
  float edge = smoothstep(0.0, 0.1, vUv.x) * (1.0 - smoothstep(0.9, 1.0, vUv.x));
  float glow = 0.25 + 0.75 * t.r;
  gl_FragColor = vec4(uColor * glow * 1.3, (0.25 + t.r * 0.6) * edge);
}`;

const SIMPLE_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export function buildTrackView(track: CompiledTrack, quality: "high" | "low"): TrackView {
  const def = track.def;
  const theme = def.theme;
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const accent = new Color(def.accent[0]);
  const accent2 = new Color(def.accent[1]);
  const grounded = !def.floating;
  const hw = (i: number) => track.halfWidth[i]!;
  const wall = (i: number) => track.wall[i]!;
  const noFloor = (i: number) => track.floor[i] === 0;
  const lowQ = quality === "low";

  /* Road */
  const road = paintRoad(theme, lowQ ? 512 : 1024);
  own(road.map);
  own(road.emissive);
  own(road.rough);
  const roadMat = own(
    new MeshStandardMaterial({
      map: road.map,
      emissiveMap: road.emissive,
      emissive: new Color("#ffffff"),
      emissiveIntensity: ROAD_LOOKS[theme].emissive,
      roughnessMap: road.rough,
      roughness: 1,
      metalness: ROAD_LOOKS[theme].metalness,
    }),
  );
  const roadGeo = own(strip(track, { d0: (i) => -hw(i), d1: hw, h0: 0, h1: 0, across: 8, vScale: 16, skip: noFloor }));
  const roadMesh = new Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  /* Curbs */
  const curbTex = own(paintCurb(ROAD_LOOKS[theme].curb[0], ROAD_LOOKS[theme].curb[1]));
  const curbMat = own(new MeshStandardMaterial({ map: curbTex, roughness: 0.6, metalness: 0.1, emissive: accent, emissiveIntensity: grounded ? 0 : 0.35 }));
  for (const side of [-1, 1] as const) {
    const g = own(
      strip(track, {
        d0: (i) => side * hw(i),
        d1: (i) => side * (hw(i) + 1.3),
        h0: 0.02,
        h1: 0.12,
        across: 1,
        vScale: 4,
        skip: noFloor,
        flip: side < 0,
      }),
    );
    const m = new Mesh(g, curbMat);
    m.receiveShadow = true;
    group.add(m);
  }

  /* Shoulders */
  const shoulderTex = own(paintShoulder(theme));
  const shoulderMat = own(new MeshStandardMaterial({ map: shoulderTex, roughness: 0.95, metalness: grounded ? 0 : 0.5 }));
  for (const side of [-1, 1] as const) {
    const g = own(
      strip(track, {
        d0: (i) => side * (hw(i) + 1.3),
        d1: (i) => side * (wall(i) + 0.6),
        h0: 0.12,
        h1: grounded ? -0.1 : 0.05,
        across: 2,
        vScale: 10,
        skip: noFloor,
        flip: side < 0,
      }),
    );
    const m = new Mesh(g, shoulderMat);
    m.receiveShadow = true;
    group.add(m);
  }

  /* Slab underneath + skirts */
  const slabMat = own(new MeshStandardMaterial({ color: grounded ? "#3b2b24" : "#1b1d29", roughness: 0.6, metalness: grounded ? 0.1 : 0.7 }));
  const depth = grounded ? 3.5 : 1.6;
  const under = own(strip(track, { d0: (i) => -wall(i) - 0.6, d1: (i) => wall(i) + 0.6, h0: -depth, h1: -depth, across: 2, vScale: 20, skip: noFloor, flip: true }));
  group.add(new Mesh(under, slabMat));
  for (const side of [-1, 1] as const) {
    const g = own(
      strip(track, {
        d0: (i) => side * (wall(i) + 0.6),
        d1: (i) => side * (wall(i) + 0.6),
        h0: grounded ? -0.1 : 0.05,
        h1: -depth,
        across: 1,
        vScale: 20,
        skip: noFloor,
        flip: side > 0,
      }),
    );
    group.add(new Mesh(g, slabMat));
  }
  if (!grounded) {
    // Glowing underside strips.
    const glowMat = own(new MeshBasicMaterial({ color: accent2.clone().multiplyScalar(1.6), toneMapped: false }));
    for (const side of [-1, 1] as const) {
      const g = own(
        strip(track, {
          d0: (i) => side * (wall(i) * 0.55),
          d1: (i) => side * (wall(i) * 0.55 + 0.5),
          h0: -depth - 0.02,
          h1: -depth - 0.02,
          across: 1,
          vScale: 20,
          skip: noFloor,
          flip: side > 0,
        }),
      );
      group.add(new Mesh(g, glowMat));
    }
  }

  /* Walls: a metal rail and an energy barrier above it */
  const railMat = own(new MeshStandardMaterial({ color: "#c9cfdc", roughness: 0.3, metalness: 0.85 }));
  const railGlowMat = own(new MeshBasicMaterial({ color: accent.clone().multiplyScalar(2), toneMapped: false }));
  const barrierMat = own(
    new ShaderMaterial({
      vertexShader: BARRIER_VS,
      fragmentShader: BARRIER_FS,
      uniforms: { uTime: { value: 0 }, uColor: { value: accent2.clone() }, uFocus: { value: new Vector3() } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    }),
  );
  for (const side of [-1, 1] as const) {
    const bit = side < 0 ? 1 : 2;
    const openHere = (i: number) => (track.open[i]! & bit) !== 0 || noFloor(i);
    const at = (i: number) => side * (wall(i) + 0.45);
    const rail = own(strip(track, { d0: at, d1: at, h0: 0, h1: 1.1, across: 1, vScale: 8, stride: 2, skip: openHere, flip: side > 0 }));
    group.add(new Mesh(rail, railMat));
    const cap = own(strip(track, { d0: at, d1: (i) => side * (wall(i) + 0.85), h0: 1.1, h1: 1.1, across: 1, vScale: 8, stride: 2, skip: openHere, flip: side < 0 }));
    group.add(new Mesh(cap, railMat));
    const glow = own(strip(track, { d0: at, d1: at, h0: 0.7, h1: 0.85, across: 1, vScale: 8, stride: 2, skip: openHere, flip: side > 0 }));
    const inner = (i: number) => at(i) - side * 0.02;
    const glowIn = own(strip(track, { d0: inner, d1: inner, h0: 0.7, h1: 0.85, across: 1, vScale: 8, stride: 2, skip: openHere, flip: side > 0 }));
    group.add(new Mesh(glow, railGlowMat));
    group.add(new Mesh(glowIn, railGlowMat));
    const barrier = own(strip(track, { d0: at, d1: at, h0: 1.1, h1: 3.6, across: 1, vScale: 1, stride: 2, skip: openHere }));
    // Barrier uv: x = height (0..1), y = distance along (for the hex pattern).
    const uv = barrier.getAttribute("uv") as BufferAttribute;
    for (let k = 0; k < uv.count; k++) {
      const u = uv.getX(k);
      const v = uv.getY(k);
      uv.setXY(k, u, v / 2);
    }
    const bm = new Mesh(barrier, barrierMat);
    bm.renderOrder = 2;
    group.add(bm);
    // Open edges get a hazard glow line so you can see the drop.
    const edgeMat = own(new MeshBasicMaterial({ color: new Color("#ff4a3d").multiplyScalar(2), toneMapped: false }));
    const edge = own(
      strip(track, {
        d0: (i) => side * (wall(i) + 0.3),
        d1: (i) => side * (wall(i) + 0.6),
        h0: 0.08,
        h1: 0.08,
        across: 1,
        vScale: 8,
        skip: (i) => !openHere(i) || noFloor(i),
        flip: side < 0,
      }),
    );
    group.add(new Mesh(edge, edgeMat));
  }

  /* Lamps along the rails */
  const lampGeo = own(new SphereGeometry(0.28, 10, 8));
  const lampMat = own(new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
  const lampSpots: { s: number; side: -1 | 1 }[] = [];
  for (let s = 0; s < track.length; s += lowQ ? 16 : 10) {
    const i = Math.floor(s / track.step) % track.count;
    for (const side of [-1, 1] as const) {
      const bit = side < 0 ? 1 : 2;
      if ((track.open[i]! & bit) !== 0 || noFloor(i)) continue;
      lampSpots.push({ s, side });
    }
  }
  const lamps = new InstancedMesh(lampGeo, lampMat, lampSpots.length);
  const f = newFrame();
  const m4 = new Matrix4();
  const tmp = new Vector3();
  lampSpots.forEach((spot, k) => {
    frameAt(track, spot.s, f);
    tmp.copy(f.pos).addScaledVector(f.right, spot.side * (f.wallOffset + 0.65)).addScaledVector(f.up, 1.35);
    m4.makeTranslation(tmp.x, tmp.y, tmp.z);
    lamps.setMatrixAt(k, m4);
    const c = (Math.floor(spot.s / 10) % 2 === 0 ? accent : accent2).clone().multiplyScalar(1.3);
    lamps.setColorAt(k, c);
  });
  group.add(lamps);

  /* Neon arches over the road */
  const archMat = own(new MeshBasicMaterial({ color: accent.clone().multiplyScalar(2.4), toneMapped: false }));
  const archMat2 = own(new MeshBasicMaterial({ color: accent2.clone().multiplyScalar(2.4), toneMapped: false }));
  const pillarMat = own(new MeshStandardMaterial({ color: "#2a2d3a", roughness: 0.4, metalness: 0.8 }));
  const q = new Quaternion();
  const basis = new Matrix4();
  const place = (obj: Object3D, s: number, d: number, h: number) => {
    frameAt(track, s, f);
    basis.makeBasis(f.right, f.up, tmp.copy(f.fwd).negate());
    q.setFromRotationMatrix(basis);
    obj.quaternion.copy(q);
    obj.position.copy(f.pos).addScaledVector(f.right, d).addScaledVector(f.up, h);
  };
  const archEvery = lowQ ? 260 : 170;
  const hazardStripe = own(paintCurb("#ffcf2e", "#1a1a1a"));
  hazardStripe.repeat.set(1, 6);
  const trussMat = own(new MeshStandardMaterial({ color: "#8a4a2e", roughness: 0.55, metalness: 0.7 }));
  const stripeMat = own(new MeshStandardMaterial({ map: hazardStripe, roughness: 0.5, metalness: 0.3 }));
  const goldMat = own(new MeshStandardMaterial({ color: "#ffcf6a", roughness: 0.2, metalness: 1, emissive: "#ff9a2e", emissiveIntensity: 0.25 }));
  const iceMat = own(new MeshStandardMaterial({ color: "#cfe8ff", roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.8, emissive: "#5ab0ff", emissiveIntensity: 0.35 }));
  let k = 0;
  for (let s = 120; !def.arena && s < track.length - 60; s += archEvery, k++) {
    const i = Math.floor(s / track.step) % track.count;
    if (noFloor(i)) continue;
    const r = track.wall[i]! + 1.5;
    const gate = new Group();
    switch (theme) {
      case "mars": {
        // Rusted steel truss gantry with hazard-striped legs and a lamp bar.
        const leg = own(new BoxGeometry(1.2, 11, 1.2));
        for (const side of [-1, 1]) {
          const m = new Mesh(leg, stripeMat);
          m.position.set(side * r, 5.5, 0);
          m.castShadow = true;
          gate.add(m);
        }
        const beam = new Mesh(own(new BoxGeometry(r * 2 + 1.2, 1.4, 1.4)), trussMat);
        beam.position.set(0, 10.6, 0);
        gate.add(beam);
        for (let x = -r + 2; x <= r - 2; x += 3) {
          const brace = new Mesh(own(new BoxGeometry(0.25, 2.4, 0.25)), trussMat);
          brace.position.set(x, 9.3, 0);
          brace.rotation.z = x % 2 ? 0.6 : -0.6;
          gate.add(brace);
        }
        const lamps = new Mesh(own(new BoxGeometry(r * 1.6, 0.35, 0.5)), k % 2 ? archMat : archMat2);
        lamps.position.set(0, 9.8, 0.75);
        gate.add(lamps);
        break;
      }
      case "luna":
      case "europa": {
        // Tall light towers either side, with a banner line between them.
        const mast = own(new CylinderGeometry(0.35, 0.55, 13, 10));
        for (const side of [-1, 1]) {
          const m = new Mesh(mast, pillarMat);
          m.position.set(side * r, 6.5, 0);
          m.castShadow = true;
          gate.add(m);
          const head = new Mesh(own(new BoxGeometry(2.4, 0.9, 0.9)), archMat2);
          head.position.set(side * r, 13, 0);
          gate.add(head);
        }
        const banner = new Mesh(own(new BoxGeometry(r * 2, 0.18, 0.18)), theme === "europa" ? iceMat : archMat);
        banner.position.set(0, 12.2, 0);
        gate.add(banner);
        break;
      }
      case "saturn": {
        // Full golden rings you fly through; the lower half hangs below the floating road.
        const ring = new Mesh(own(new TorusGeometry(r + 1, 0.55, 12, 64)), goldMat);
        gate.add(ring);
        const glow = new Mesh(own(new TorusGeometry(r + 1, 0.2, 8, 64)), k % 2 ? archMat : archMat2);
        glow.position.z = 0.5;
        gate.add(glow);
        break;
      }
      case "belt": {
        // Hexagonal scanner gates.
        const hex = new Mesh(own(new TorusGeometry(r + 0.5, 0.45, 6, 6, Math.PI)), k % 2 ? archMat : archMat2);
        hex.rotation.z = 0;
        gate.add(hex);
        const frame = new Mesh(own(new TorusGeometry(r + 1.1, 0.3, 6, 6, Math.PI)), pillarMat);
        gate.add(frame);
        break;
      }
      case "sun": {
        // Angled heat-shield fins leaning over the road.
        const fin = own(new BoxGeometry(0.4, 12, 3));
        for (const side of [-1, 1]) {
          const m = new Mesh(fin, goldMat);
          m.position.set(side * (r - 1), 5.5, 0);
          m.rotation.z = side * 0.35;
          gate.add(m);
          const edge = new Mesh(own(new BoxGeometry(0.15, 12, 0.3)), archMat);
          edge.position.set(side * (r - 1) - side * 0.25, 5.5, 1.5);
          edge.rotation.z = side * 0.35;
          gate.add(edge);
        }
        break;
      }
      default: {
        const tg = own(new TorusGeometry(r, 0.35, 8, 48, Math.PI));
        gate.add(new Mesh(tg, k % 2 ? archMat : archMat2));
        const ring2 = new Mesh(tg, pillarMat);
        ring2.scale.setScalar(1.04);
        ring2.position.z = -0.5;
        gate.add(ring2);
      }
    }
    place(gate, s, 0, 0);
    group.add(gate);
  }

  /* Start / finish */
  const checker = own(paintChecker());
  const checkerMat = own(new MeshStandardMaterial({ map: checker, roughness: 0.5 }));
  if (!def.arena) {
    const w = track.wall[0]! * 2;
    const g = own(new PlaneGeometry(w, 4));
    const band = new Mesh(g, checkerMat);
    place(band, 0, 0, 0.04);
    band.rotateX(-Math.PI / 2);
    band.receiveShadow = true;
    group.add(band);
  }
  const gantry = new Group();
  const lightsMats: MeshBasicMaterial[] = [];
  {
    const w = track.wall[0]! + 2;
    const pillarGeo = own(new BoxGeometry(1.4, 12, 1.4));
    for (const side of [-1, 1]) {
      const p = new Mesh(pillarGeo, pillarMat);
      p.position.set(side * w, 6, 0);
      p.castShadow = true;
      gantry.add(p);
      const stripe = new Mesh(own(new BoxGeometry(0.2, 11, 1.45)), archMat);
      stripe.position.set(side * (w - 0.72), 6, 0);
      gantry.add(stripe);
    }
    const beam = new Mesh(own(new BoxGeometry(w * 2 + 1.4, 3.2, 1.6)), pillarMat);
    beam.position.set(0, 11.2, 0);
    beam.castShadow = true;
    gantry.add(beam);
    const signTex = own(paintSign("NOVA RALLY", def.accent[0], 1024, 160));
    const sign = new Mesh(own(new PlaneGeometry(w * 1.2, (w * 1.2 * 160) / 1024)), own(new MeshBasicMaterial({ map: signTex, toneMapped: false })));
    sign.position.set(0, 11.2, 0.82);
    gantry.add(sign);
    const back = sign.clone();
    back.rotation.y = Math.PI;
    back.position.z = -0.82;
    gantry.add(back);
    // Countdown lights hang under the beam, facing the grid.
    const lampG = own(new CylinderGeometry(0.75, 0.75, 0.3, 24));
    for (let k = 0; k < 4; k++) {
      const mat = own(new MeshBasicMaterial({ color: "#220808", toneMapped: false }));
      lightsMats.push(mat);
      const lamp = new Mesh(lampG, mat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set((k - 1.5) * 2.2, 8.6, 0.9);
      gantry.add(lamp);
      const housing = new Mesh(own(new BoxGeometry(1.9, 1.9, 0.5)), pillarMat);
      housing.position.set((k - 1.5) * 2.2, 8.6, 0.55);
      gantry.add(housing);
    }
    place(gantry, 0, 0, 0);
    // Face the grid (which sits behind the line). Arenas have no start line.
    gantry.rotateY(Math.PI);
    if (!def.arena) group.add(gantry);
  }

  /* Boost pads */
  const chevrons = own(paintChevrons("#ffffff"));
  const padMats: ShaderMaterial[] = [];
  for (const pad of track.boostPads) {
    const mat = own(
      new ShaderMaterial({
        vertexShader: SIMPLE_VS,
        fragmentShader: PAD_FS,
        uniforms: { uTime: { value: 0 }, uColor: { value: new Color(def.accent[1]) }, uMap: { value: chevrons } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    );
    padMats.push(mat);
    const i = Math.floor(wrapS(pad.s, track.length) / track.step) % track.count;
    const geo = own(
      strip(
        { ...track, count: track.count },
        {
          d0: () => pad.d * track.halfWidth[i]! - 2.8,
          d1: () => pad.d * track.halfWidth[i]! + 2.8,
          h0: 0.06,
          h1: 0.06,
          across: 1,
          vScale: PAD_LENGTH,
          skip: (k) => {
            const ds = ((k * track.step - pad.s + track.length * 1.5) % track.length) - track.length / 2;
            return ds < -PAD_LENGTH / 2 || ds > PAD_LENGTH / 2;
          },
        },
      ),
    );
    group.add(new Mesh(geo, mat));
  }

  /* Ramps */
  const rampTex = own(paintChevrons(def.accent[1]));
  rampTex.repeat.set(3, 1);
  const rampMat = own(new MeshStandardMaterial({ color: "#c9ced9", map: rampTex, roughness: 0.35, metalness: 0.6, emissive: accent2, emissiveMap: rampTex, emissiveIntensity: 0.6 }));
  for (const ramp of track.ramps) {
    const s0 = ramp.s - RAMP_LENGTH;
    const lift = (i: number) => {
      const ds = ((i * track.step - s0 + track.length * 1.5) % track.length) - track.length / 2;
      return Math.max(0, Math.min(1, ds / RAMP_LENGTH)) * RAMP_HEIGHT;
    };
    const inRamp = (i: number) => {
      const ds = ((i * track.step - s0 + track.length * 1.5) % track.length) - track.length / 2;
      return ds < 0 || ds > RAMP_LENGTH;
    };
    const top = own(strip(track, { d0: (i) => -wall(i), d1: (i) => wall(i), h0: lift, h1: lift, across: 6, vScale: RAMP_LENGTH, skip: inRamp }));
    const rm = new Mesh(top, rampMat);
    rm.castShadow = true;
    rm.receiveShadow = true;
    group.add(rm);
    // Sloped side skirts and the lip face so it reads as a solid wedge.
    for (const side of [-1, 1] as const) {
      const skirt = own(strip(track, { d0: (i) => side * wall(i), d1: (i) => side * wall(i), h0: 0, h1: lift, across: 1, vScale: 3, skip: inRamp, flip: side < 0 }));
      group.add(new Mesh(skirt, railMat));
    }
    // Glowing lip strip.
    const lip = own(strip(track, { d0: (i) => -wall(i), d1: (i) => wall(i), h0: (i) => lift(i) + 0.02, h1: (i) => lift(i) + 0.02, across: 1, vScale: 1, skip: (i) => {
      const ds = ((i * track.step - s0 + track.length * 1.5) % track.length) - track.length / 2;
      return ds < RAMP_LENGTH - 1.2 || ds > RAMP_LENGTH;
    } }));
    group.add(new Mesh(lip, railGlowMat));
  }

  const lightColors = [new Color("#ff2a2a"), new Color("#ff2a2a"), new Color("#ff2a2a"), new Color("#2aff6a")];
  const dark = new Color("#220808");

  return {
    group,
    update(time, focus, cd) {
      barrierMat.uniforms.uTime!.value = time;
      (barrierMat.uniforms.uFocus!.value as Vector3).copy(focus);
      for (const m of padMats) m.uniforms.uTime!.value = time;
      // Countdown lights: three reds then green.
      let lit = -1;
      if (cd.phase === "countdown") lit = Math.min(2, Math.floor((cd.t / cd.length) * 3.4));
      if (cd.phase === "race" && cd.t < 2) lit = 3;
      lightsMats.forEach((mat, k) => {
        const on = lit === 3 ? k === 3 || k < 3 : k <= lit && k < 3;
        const c = lit === 3 ? lightColors[3]! : lightColors[k]!;
        mat.color.copy(on ? c : dark).multiplyScalar(on ? 3 : 1);
      });
    },
    dispose() {
      for (const d of disposables) d.dispose();
      lamps.dispose();
    },
  };
}

export type { Material, Texture };
void DynamicDrawUsage;
