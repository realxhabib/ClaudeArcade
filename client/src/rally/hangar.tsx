"use client";

/**
 * The garage hangar: a full-screen 3D bay with your ship on a lit turntable
 * (drag to spin it), a reflective deck, neon light strips, ceiling spots, a
 * huge window onto a ringed planet, and drifting dust. It sits behind the
 * garage menus. Cost follows the graphics setting.
 */

import { useEffect, useRef } from "react";
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RepeatWrapping,
  RingGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  TorusGeometry,
  WebGLRenderer,
  type Material,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { detectQuality } from "./scene";
import { buildShip, type PartChoice, type Pilot, type ShipDesign, type ShipModel } from "./ships";
import type { Livery } from "./types";

interface Props {
  design: ShipDesign;
  livery: Livery;
  pilot: Pilot;
  parts?: PartChoice;
  reduced: boolean;
  /** Where the ship sits on screen, as a fraction of the width (0.5 = centre). */
  focusX: number;
  className?: string;
}

function deckTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  // Four deck plates per tile: alternating tones, brushed streaks, bevelled seams and corner bolts.
  const tones = ["#1d1a2b", "#221f33", "#1a1828", "#201d30"];
  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * 256;
      const y = py * 256;
      g.fillStyle = tones[py * 2 + px]!;
      g.fillRect(x, y, 256, 256);
      g.globalAlpha = 0.05;
      for (let k = 0; k < 60; k++) {
        g.fillStyle = k % 2 ? "#ffffff" : "#000000";
        g.fillRect(x, y + Math.random() * 256, 256, 1 + Math.random() * 2);
      }
      g.globalAlpha = 1;
      g.fillStyle = "#0b0a12";
      g.fillRect(x, y, 256, 5);
      g.fillRect(x, y, 5, 256);
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(x + 5, y + 5, 251, 2);
      g.fillRect(x + 5, y + 5, 2, 251);
      for (const [bx, by] of [[18, 18], [238, 18], [18, 238], [238, 238]] as const) {
        g.fillStyle = "#3a3650";
        g.beginPath();
        g.arc(x + bx, y + by, 5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "rgba(255,255,255,0.18)";
        g.beginPath();
        g.arc(x + bx - 1.5, y + by - 1.5, 2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // Grip pattern on one plate.
  g.fillStyle = "rgba(255,255,255,0.05)";
  for (let yy = 30; yy < 230; yy += 14) for (let xx = 286; xx < 490; xx += 14) g.fillRect(xx + ((yy / 14) % 2) * 7, yy, 7, 2.5);
  g.fillStyle = "rgba(255,255,255,0.04)";
  for (let k = 0; k < 2500; k++) g.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(10, 10);
  t.anisotropy = 8;
  return t;
}

/** Turntable top: machined concentric grooves, radial seams and a centre badge. */
function tableTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  grad.addColorStop(0, "#3a3654");
  grad.addColorStop(1, "#24213a");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  for (let r = 24; r < 256; r += 6) {
    g.strokeStyle = r % 48 === 0 ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.045)";
    g.lineWidth = r % 48 === 0 ? 3 : 1;
    g.beginPath();
    g.arc(256, 256, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = "rgba(0,0,0,0.4)";
  g.lineWidth = 3;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(256 + Math.cos(a) * 96, 256 + Math.sin(a) * 96);
    g.lineTo(256 + Math.cos(a) * 250, 256 + Math.sin(a) * 250);
    g.stroke();
  }
  g.fillStyle = "#ffc93d";
  g.font = "bold italic 34px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("NOVA", 256, 240);
  g.fillText("RALLY", 256, 276);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Yellow/black hazard chevrons around the turntable (u runs around the ring). */
function hazardTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16141f";
  g.fillRect(0, 0, 1024, 64);
  g.fillStyle = "#ffc93d";
  for (let x = -64; x < 1024 + 64; x += 48) {
    g.beginPath();
    g.moveTo(x, 8);
    g.lineTo(x + 22, 8);
    g.lineTo(x + 46, 56);
    g.lineTo(x + 24, 56);
    g.closePath();
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function planetTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  const bands = ["#e8b98a", "#d79a6a", "#f2d2a8", "#c98a5a", "#ecc39a", "#b9784c", "#f0d0a4"];
  for (let y = 0; y < 256; y += 4) {
    g.fillStyle = bands[Math.floor((y / 256) * 37 + Math.sin(y * 0.1) * 2) % bands.length]!;
    g.fillRect(0, y, 512, 4);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function HangarScene({ design, livery, pilot, parts, reduced, focusX, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<{ swap: (d: ShipDesign, l: Livery, p: Pilot, parts?: PartChoice) => void; setFocus: (x: number) => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const quality = detectQuality();
    const hi = quality.level === "high";
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: quality.level !== "low", alpha: false, powerPreference: "high-performance" });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(quality.level === "high" ? 1.5 : 1, window.devicePixelRatio || 1));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.shadowMap.enabled = quality.level !== "low";
    renderer.shadowMap.type = PCFSoftShadowMap;
    const disposables: { dispose(): void }[] = [];
    const own = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    const scene = new Scene();
    scene.background = new Color("#07051a");
    const pmrem = new PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = envTex;
    scene.environmentIntensity = 0.45;
    disposables.push(envTex);

    const camera = new PerspectiveCamera(36, 1, 0.1, 400);

    // Lights: cool hemisphere fill, a warm key spot from the ceiling, a magenta rim from behind.
    scene.add(new HemisphereLight("#9fb4ff", "#1a0f22", 0.5));
    const key = new SpotLight("#fff1dc", 260, 40, 0.5, 0.6, 1.6);
    key.position.set(3, 12, 6);
    key.castShadow = renderer.shadowMap.enabled;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    scene.add(key, key.target);
    const rim = new DirectionalLight("#ff5ad1", 1.6);
    rim.position.set(-6, 4, -8);
    scene.add(rim);
    const fill = new DirectionalLight("#46e6ff", 0.8);
    fill.position.set(8, 2, -2);
    scene.add(fill);

    // Deck.
    const deckTex = own(deckTexture());
    const deck = new Mesh(own(new CircleGeometry(60, 64)), own(new MeshStandardMaterial({ map: deckTex, metalness: 0.7, roughness: 0.32 })));
    deck.rotation.x = -Math.PI / 2;
    deck.receiveShadow = true;
    scene.add(deck);

    // Turntable with glowing rings.
    const tableMat = own(new MeshStandardMaterial({ color: "#2b2840", metalness: 0.85, roughness: 0.25 }));
    const tableTop = own(new MeshStandardMaterial({ map: own(tableTexture()), metalness: 0.8, roughness: 0.3 }));
    // Cylinder groups: side, top, bottom.
    const table = new Mesh(own(new CylinderGeometry(3.4, 3.6, 0.3, 64)), [tableMat, tableTop, tableMat]);
    table.position.y = 0.15;
    table.receiveShadow = true;
    scene.add(table);
    const ringMat = own(new MeshBasicMaterial({ color: new Color(livery.glow).multiplyScalar(2), toneMapped: false }));
    const ring = new Mesh(own(new TorusGeometry(3.45, 0.05, 8, 96)), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.31;
    scene.add(ring);
    const glowMat = own(new MeshBasicMaterial({ color: new Color(livery.glow), transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }));
    const glow = new Mesh(own(new RingGeometry(3.5, 5.2, 96)), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    scene.add(glow);
    // Hazard band around the bay and guide lights running out across the deck.
    const hazTex = own(hazardTexture());
    hazTex.repeat.set(6, 1);
    const haz = new Mesh(own(new RingGeometry(6.2, 6.9, 128, 1)), own(new MeshStandardMaterial({ map: hazTex, metalness: 0.3, roughness: 0.6 })));
    // Map u around the ring instead of across it.
    {
      const uv = haz.geometry.getAttribute("uv");
      const pos = haz.geometry.getAttribute("position");
      for (let i = 0; i < uv.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        uv.setXY(i, Math.atan2(y, x) / (Math.PI * 2) + 0.5, (Math.hypot(x, y) - 6.2) / 0.7);
      }
      uv.needsUpdate = true;
    }
    haz.rotation.x = -Math.PI / 2;
    haz.position.y = 0.015;
    haz.receiveShadow = true;
    scene.add(haz);
    const guideGeo = own(new CircleGeometry(0.09, 12));
    const guideMats = ["#46e6ff", "#ff5ad1"].map((col) => own(new MeshBasicMaterial({ color: new Color(col).multiplyScalar(2.4), toneMapped: false })));
    for (let ray = 0; ray < 8; ray++) {
      const a = (ray / 8) * Math.PI * 2 + Math.PI / 8;
      for (let k = 0; k < 7; k++) {
        const dot = new Mesh(guideGeo, guideMats[ray % 2]!);
        const r = 8 + k * 2.2;
        dot.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
        dot.rotation.x = -Math.PI / 2;
        scene.add(dot);
      }
    }

    // Bay walls: a curved shell with neon strips, open at the back onto a window.
    const wallMat = own(new MeshStandardMaterial({ color: "#1b1830", metalness: 0.6, roughness: 0.5, side: BackSide }));
    const walls = new Mesh(own(new CylinderGeometry(26, 26, 18, 48, 1, true, Math.PI * 0.3, Math.PI * 1.4)), wallMat);
    walls.position.y = 9;
    walls.rotation.y = Math.PI;
    scene.add(walls);
    const stripColors = ["#ff5ad1", "#46e6ff", "#ffd166"];
    for (let k = 0; k < 3; k++) {
      const strip = new Mesh(
        own(new CylinderGeometry(25.6, 25.6, 0.12, 48, 1, true, Math.PI * 0.3, Math.PI * 1.4)),
        own(new MeshBasicMaterial({ color: new Color(stripColors[k]!).multiplyScalar(2.2), side: BackSide, toneMapped: false })),
      );
      strip.position.y = 2 + k * 3.2;
      strip.rotation.y = Math.PI;
      scene.add(strip);
    }
    // Ceiling light bars.
    for (let k = -2; k <= 2; k++) {
      const bar = new Mesh(own(new PlaneGeometry(10, 0.5)), own(new MeshBasicMaterial({ color: new Color("#fff4e0").multiplyScalar(2), side: DoubleSide, toneMapped: false })));
      bar.position.set(0, 16, k * 4);
      bar.rotation.x = Math.PI / 2;
      scene.add(bar);
    }

    // The window: stars, a ringed planet and its moon beyond.
    const space = new Group();
    space.position.set(0, 6, -60);
    scene.add(space);
    const starCount = hi ? 1500 : 600;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) starPos.set([(Math.random() - 0.5) * 220, (Math.random() - 0.2) * 110, -Math.random() * 60], i * 3);
    const starGeo = own(new BufferGeometry());
    starGeo.setAttribute("position", new BufferAttribute(starPos, 3));
    space.add(new Points(starGeo, own(new PointsMaterial({ color: "#ffffff", size: 0.5, sizeAttenuation: true }))));
    const pTex = own(planetTexture());
    const planet = new Mesh(own(new SphereGeometry(16, 48, 32)), own(new MeshStandardMaterial({ map: pTex, roughness: 0.9, emissive: "#3a1a10", emissiveIntensity: 0.4 })));
    planet.position.set(-22, 10, -40);
    planet.rotation.z = 0.3;
    space.add(planet);
    const rings = new Mesh(own(new RingGeometry(20, 32, 96)), own(new MeshBasicMaterial({ color: "#f2d9b0", transparent: true, opacity: 0.55, side: DoubleSide })));
    rings.position.copy(planet.position);
    rings.rotation.set(-1.25, 0.2, 0.3);
    space.add(rings);
    const moon = new Mesh(own(new SphereGeometry(3, 24, 16)), own(new MeshStandardMaterial({ color: "#b8c4d8", roughness: 1 })));
    moon.position.set(30, 22, -20);
    space.add(moon);
    const sunLight = new DirectionalLight("#ffe2b0", 1.2);
    sunLight.position.set(40, 30, 20);
    sunLight.target = planet;
    space.add(sunLight);
    // Window frame struts.
    const strutMat = own(new MeshStandardMaterial({ color: "#3b3754", metalness: 0.9, roughness: 0.3 }));
    const strutGlow = own(new MeshBasicMaterial({ color: new Color("#46e6ff").multiplyScalar(1.8), toneMapped: false }));
    for (let k = -3; k <= 3; k++) {
      const strut = new Mesh(own(new BoxGeometry(0.7, 18, 0.7)), strutMat);
      strut.position.set(k * 7, 9, -24);
      scene.add(strut);
      const edge = new Mesh(own(new BoxGeometry(0.08, 16, 0.08)), strutGlow);
      edge.position.set(k * 7, 9, -23.6);
      scene.add(edge);
    }

    // Dust motes in the light cone.
    const dustN = hi ? 260 : 90;
    const dustPos = new Float32Array(dustN * 3);
    for (let i = 0; i < dustN; i++) dustPos.set([(Math.random() - 0.5) * 12, Math.random() * 10, (Math.random() - 0.5) * 12], i * 3);
    const dustGeo = own(new BufferGeometry());
    dustGeo.setAttribute("position", new BufferAttribute(dustPos, 3));
    const dust = new Points(dustGeo, own(new PointsMaterial({ color: "#fff1dc", size: 0.05, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false })));
    scene.add(dust);

    // The ship.
    const holder = new Group();
    holder.position.y = 1.15;
    scene.add(holder);
    let model: ShipModel = buildShip(design, livery, quality.detail, pilot, parts);
    const shadowify = (m: ShipModel) => m.root.traverse((o) => ((o as Mesh).isMesh ? ((o as Mesh).castShadow = renderer.shadowMap.enabled) : null));
    shadowify(model);
    holder.add(model.root);
    let focus = focusX;

    api.current = {
      swap(d, l, p, pt) {
        holder.remove(model.root);
        model.dispose();
        model = buildShip(d, l, quality.detail, p, pt);
        shadowify(model);
        holder.add(model.root);
        ringMat.color.set(l.glow).multiplyScalar(2);
        glowMat.color.set(l.glow);
      },
      setFocus(x) {
        focus = x;
        resize();
      },
    };

    // Drag to spin; it eases back into a slow idle spin.
    let spin = -0.6;
    let vel = 0;
    let dragging = false;
    let lastX = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      vel = dx * 0.012;
      spin += vel;
    };
    const up = () => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    function resize() {
      const r = canvas!.getBoundingClientRect();
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / Math.max(1, r.height);
      // Shift the view so the ship sits at `focus` across the screen.
      camera.setViewOffset(r.width, r.height, (0.5 - focus) * r.width, 0, r.width, r.height);
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(canvas);
    const t0 = performance.now();
    let last = t0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      if (!dragging) {
        vel *= Math.exp(-3 * dt);
        spin += vel + (reduced ? 0 : dt * 0.35);
      }
      holder.rotation.y = spin;
      table.rotation.y = spin;
      holder.position.y = 1.15 + (reduced ? 0 : Math.sin(t * 1.8) * 0.06);
      model.setThrottle(0.35 + Math.sin(t * 3) * 0.08, 0, t);
      const orbit = reduced ? 0 : Math.sin(t * 0.15) * 0.25;
      camera.position.set(Math.sin(orbit) * 11, 4.2, Math.cos(orbit) * 11);
      camera.lookAt(0, 1.2, 0);
      planet.rotation.y = t * 0.02;
      dust.rotation.y = t * 0.03;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      model.dispose();
      for (const d of disposables) d.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh && m.material) (m.material as Material).dispose?.();
      });
      renderer.dispose();
      api.current = null;
    };
    // The model is swapped in place below; the hangar lives for the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useEffect(() => {
    api.current?.swap(design, livery, pilot, parts);
  }, [design, livery, pilot, parts]);

  useEffect(() => {
    api.current?.setFocus(focusX);
  }, [focusX]);

  return <canvas ref={canvasRef} className={className} style={{ touchAction: "pan-y" }} aria-label="Your ship in the hangar. Drag to spin it." />;
}
