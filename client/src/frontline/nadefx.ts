/**
 * Grenades on screen: a small frag model for every grenade in flight
 * (following the shared simulated path, tumbling), bounce clinks, and the
 * throw preview while the grenade button is held — a dotted arc and a ring
 * where it will come to rest.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Game, LiveNade } from "./game";
import type { NadeFlight } from "./grenade";

const ARC_POINTS = 48;

export class NadeFx {
  private readonly bodyGeo: BufferGeometry;
  private readonly bodyMat = new MeshStandardMaterial({ color: 0x3d4a2c, roughness: 0.55, metalness: 0.35 });
  private readonly meshes: Mesh[] = [];
  private readonly arc: Points;
  private readonly arcGeo = new BufferGeometry();
  private readonly arcPos = new Float32Array(ARC_POINTS * 3);
  private readonly ring: Mesh;
  private readonly group = new Group();
  private readonly clinked = new Map<LiveNade, number>();

  constructor(scene: Scene) {
    const body = new SphereGeometry(0.045, 10, 8).scale(1, 1.2, 1);
    const top = new CylinderGeometry(0.016, 0.02, 0.03, 8).translate(0, 0.06, 0);
    const spoon = new CylinderGeometry(0.006, 0.006, 0.08, 4).translate(0.03, 0.03, 0).rotateZ(0.3);
    this.bodyGeo = mergeGeometries([body.toNonIndexed(), top.toNonIndexed(), spoon.toNonIndexed()])!;
    [body, top, spoon].forEach((g) => g.dispose());
    for (let i = 0; i < 8; i++) {
      const m = new Mesh(this.bodyGeo, this.bodyMat);
      m.visible = false;
      m.castShadow = true;
      this.meshes.push(m);
      this.group.add(m);
    }
    const pa = new BufferAttribute(this.arcPos, 3);
    pa.setUsage(DynamicDrawUsage);
    this.arcGeo.setAttribute("position", pa);
    this.arc = new Points(this.arcGeo, new PointsMaterial({ color: new Color(1.6, 1.4, 1.0), size: 5, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.arc.renderOrder = 6;
    this.ring = new Mesh(new RingGeometry(0.55, 0.7, 32).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: new Color(1.6, 0.5, 0.35), transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 6;
    this.group.add(this.arc, this.ring);
    scene.add(this.group);
  }

  update(game: Game, now: number, preview: NadeFlight | null, clink: (x: number, z: number) => void): void {
    const live = game.nades;
    this.meshes.forEach((m, i) => {
      const n = live[i];
      m.visible = !!n;
      if (!n) return;
      const p = game.nadePos(n, now);
      m.position.set(p.x, p.y, p.z);
      const t = (now - n.releasedAt) / 1000;
      const moving = n.flight.path.length > 1 ? Math.max(0, 1 - t / 1.4) : 0;
      m.rotation.set(t * 11 * moving, t * 3, t * 7 * moving);
      // Clinks as it hits things.
      const done = this.clinked.get(n) ?? 0;
      const due = n.flight.bounces.filter((b) => b <= now - n.releasedAt).length;
      if (due > done) {
        clink(p.x, p.z);
        this.clinked.set(n, due);
      }
    });
    for (const n of this.clinked.keys()) if (!live.includes(n)) this.clinked.delete(n);
    if (preview) {
      const path = preview.path;
      for (let i = 0; i < ARC_POINTS; i++) {
        const p = path[Math.min(path.length - 1, Math.floor((i / (ARC_POINTS - 1)) * (path.length - 1)))]!;
        this.arcPos[i * 3] = p.x;
        this.arcPos[i * 3 + 1] = p.y;
        this.arcPos[i * 3 + 2] = p.z;
      }
      this.arcGeo.attributes.position!.needsUpdate = true;
      this.arc.visible = true;
      const end = preview.end;
      this.ring.position.set(end.x, end.y + 0.03, end.z);
      this.ring.visible = true;
    } else {
      this.arc.visible = false;
      this.ring.visible = false;
    }
  }

  dispose(): void {
    this.bodyGeo.dispose();
    this.bodyMat.dispose();
    this.arcGeo.dispose();
    (this.arc.material as PointsMaterial).dispose();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
    this.group.removeFromParent();
  }
}
