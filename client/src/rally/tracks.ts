/**
 * The five courses. Nodes are (x, height, z) in world units; features sit at
 * node indices (4.5 = halfway from node 4 to 5). The start line is node 0 and
 * every lap runs from node 0 through the list and back.
 */

import type { TrackDef, TrackNode } from "./track";

const n = (x: number, y: number, z: number, opts: Omit<TrackNode, "p"> = {}): TrackNode => ({ p: [x, y, z], ...opts });

/** Mars: a canyon run on the red planet. Offroad regolith, dust devils, meteor strikes and a jump over a chasm. */
const MARS: TrackDef = {
  id: "mars",
  name: "Olympus Canyon",
  theme: "mars",
  blurb: "Rust-red canyons on Mars. Dodge dust devils and meteor strikes, then leap the Valles chasm.",
  accent: ["#ff8a4c", "#ffd166"],
  halfWidth: 13,
  shoulder: 6,
  autoBank: 0.6,
  gravity: 1,
  floating: false,
  nodes: [
    n(0, 0, 0),
    n(0, 0, -120),
    n(15, 3, -220),
    n(80, 8, -290),
    n(180, 12, -300),
    n(250, 8, -240),
    n(265, 2, -150, { w: 12 }),
    n(220, 0, -70, { w: 12 }),
    n(240, 2, 20),
    n(310, 8, 90),
    n(300, 14, 190),
    n(220, 18, 250, { w: 14 }),
    n(130, 14, 250, { w: 14 }),
    n(40, 8, 245),
    n(-60, 4, 260),
    n(-170, 8, 240),
    n(-250, 12, 160),
    n(-240, 8, 60),
    n(-160, 4, 20, { w: 12 }),
    n(-90, 2, 90, { w: 12 }),
    n(-20, 0, 110),
  ],
  boostPads: [
    { at: 0.55, d: 0.45 },
    { at: 4.4, d: -0.35 },
    { at: 9.4, d: 0 },
    { at: 13.4, d: -0.4 },
    { at: 16.6, d: 0.45 },
  ],
  itemRows: [1.5, 8.3, 13.9, 18.9],
  coins: [
    { at: 0.9, d: -0.5, n: 5 },
    { at: 3.2, d: 0.3, n: 6 },
    { at: 7.3, d: -0.2, n: 4 },
    { at: 10.2, d: 0.5, n: 5 },
    { at: 14.8, d: 0, n: 6 },
    { at: 17.6, d: -0.4, n: 5 },
  ],
  ramps: [{ at: 11.6, lift: 17 }],
  gaps: [{ from: 11.72, to: 12.08 }],
  open: [],
  hazards: [
    { kind: "dust", at: 6.5, period: 5.2, phase: 0 },
    { kind: "dust", at: 15.4, period: 6.1, phase: 1.7 },
    { kind: "meteor", at: 3.4, d: 0.35, period: 7, phase: 0.5 },
    { kind: "meteor", at: 3.7, d: -0.4, period: 7, phase: 4 },
    { kind: "meteor", at: 12.9, d: -0.3, period: 6.5, phase: 2.2 },
    { kind: "meteor", at: 19.4, d: 0.3, period: 8, phase: 1 },
  ],
};

/** The asteroid belt: a floating ribbon between tumbling rocks, with open edges to fall from. */
const BELT: TrackDef = {
  id: "belt",
  name: "Asteroid Gauntlet",
  theme: "belt",
  blurb: "A floating ribbon through the belt. Rolling asteroids, open edges and a long drop to nowhere.",
  accent: ["#8f7bff", "#46e6ff"],
  halfWidth: 12.5,
  shoulder: 2.5,
  autoBank: 1,
  gravity: 1,
  floating: true,
  nodes: [
    n(0, 0, 0),
    n(0, 6, -130),
    n(30, 22, -230),
    n(120, 34, -280),
    n(220, 24, -250),
    n(270, 4, -160),
    n(240, -18, -70),
    n(160, -28, -40, { w: 13.5 }),
    n(110, -20, 40, { w: 13.5 }),
    n(160, -6, 120),
    n(260, 10, 150),
    n(300, 28, 240),
    n(220, 36, 320),
    n(100, 24, 310),
    n(0, 6, 280),
    n(-110, -12, 300),
    n(-220, -4, 250),
    n(-270, 14, 150),
    n(-230, 26, 60),
    n(-140, 16, 40, { w: 11.5 }),
    n(-70, 4, 110, { w: 11.5 }),
    n(-10, 0, 90),
  ],
  boostPads: [
    { at: 0.5, d: -0.4 },
    { at: 5.5, d: 0.35 },
    { at: 9.6, d: -0.3 },
    { at: 13.6, d: 0 },
    { at: 17.5, d: 0.4 },
    { at: 20.4, d: 0 },
  ],
  itemRows: [1.6, 7.3, 12.2, 17.1],
  coins: [
    { at: 1.1, d: 0.4, n: 5 },
    { at: 2.4, d: -0.6, n: 4 },
    { at: 6.3, d: 0, n: 5 },
    { at: 10.6, d: -0.5, n: 5 },
    { at: 14.4, d: 0.6, n: 4 },
    { at: 18.3, d: -0.3, n: 5 },
  ],
  ramps: [{ at: 7.72, lift: 15 }],
  gaps: [{ from: 7.84, to: 8.18 }],
  open: [
    { from: 1.3, to: 2.7, side: 0 },
    { from: 6.1, to: 7.6, side: -1 },
    { from: 13.2, to: 15.4, side: 0 },
  ],
  hazards: [
    { kind: "asteroid", at: 4.5, size: 4.5, period: 6, phase: 0 },
    { kind: "asteroid", at: 9.3, size: 5.5, period: 7.5, phase: 2 },
    { kind: "asteroid", at: 11.4, size: 4, period: 5, phase: 1 },
    { kind: "asteroid", at: 12.6, size: 6, period: 8, phase: 3.5 },
    { kind: "asteroid", at: 16.4, size: 5, period: 6.5, phase: 0.7 },
    { kind: "asteroid", at: 19.2, size: 4.5, period: 5.5, phase: 2.6 },
  ],
};

/** Saturn: through the rings, with a full loop and a corkscrew roll. */
const LOOP_R = 36;
const loop = (cx: number, cy: number, cz: number, x0: number, x1: number): TrackNode[] =>
  Array.from({ length: 9 }, (_, k) => {
    const th = (k / 8) * Math.PI * 2;
    return n(x0 + ((x1 - x0) * k) / 8, cy + LOOP_R - LOOP_R * Math.cos(th), cz - LOOP_R * Math.sin(th), { w: 11 });
  });

const SATURN: TrackDef = {
  id: "saturn",
  name: "Ring Road",
  theme: "saturn",
  blurb: "Skim Saturn's rings through a full loop and a corkscrew roll. Ice shards drift across the road.",
  accent: ["#ffd98a", "#7fd6ff"],
  halfWidth: 12,
  shoulder: 2.5,
  autoBank: 1.1,
  gravity: 1,
  floating: true,
  nodes: [
    n(0, 0, 0),
    n(0, 0, -60),
    n(0, 0, -110, { w: 11 }),
    ...loop(0, 0, -150, 4, 40),
    n(42, 0, -205),
    n(60, 4, -280),
    n(140, 10, -320),
    n(240, 14, -300),
    n(300, 10, -220),
    n(310, 4, -120),
    n(300, 6, -40, { bank: 0 }),
    n(290, 8, 40, { bank: 120 }),
    n(280, 10, 120, { bank: 240 }),
    n(270, 10, 200, { bank: 360 }),
    n(210, 6, 270),
    n(100, 0, 290),
    n(-20, -6, 260),
    n(-130, -10, 280),
    n(-230, -4, 220),
    n(-270, 6, 120),
    n(-230, 10, 20),
    n(-150, 6, -10),
    n(-80, 2, 40),
    n(-20, 0, 70),
  ],
  boostPads: [
    { at: 1.2, d: 0 },
    { at: 2.6, d: 0 },
    { at: 13.5, d: 0.3 },
    { at: 16.5, d: -0.3 },
    { at: 20.5, d: 0.4 },
    { at: 24.5, d: -0.3 },
  ],
  itemRows: [0.6, 12.4, 18.5, 23.2],
  coins: [
    { at: 5.5, d: 0, n: 6 },
    { at: 8.2, d: 0, n: 6 },
    { at: 14.4, d: -0.5, n: 5 },
    { at: 17.6, d: 0.5, n: 5 },
    { at: 21.4, d: -0.3, n: 5 },
    { at: 25.3, d: 0.3, n: 4 },
  ],
  ramps: [],
  gaps: [],
  open: [
    { from: 19.2, to: 21.6, side: 0 },
    { from: 25.2, to: 26.4, side: 1 },
  ],
  hazards: [
    { kind: "asteroid", at: 14.6, size: 3.2, period: 5, phase: 0 },
    { kind: "asteroid", at: 15.3, size: 3.6, period: 6, phase: 2 },
    { kind: "asteroid", at: 22.5, size: 4, period: 5.5, phase: 1.2 },
    { kind: "asteroid", at: 26.6, size: 3.5, period: 4.5, phase: 3 },
  ],
};

/** A space station in a nebula: a gravity flip where you race upside down under the road. */
const NEBULA: TrackDef = {
  id: "nebula",
  name: "Station Zero",
  theme: "nebula",
  blurb: "Neon megastructures in a violet nebula. Flip upside down under the road and dodge plasma arcs.",
  accent: ["#ff4fd8", "#36f3ff"],
  halfWidth: 12,
  shoulder: 2,
  autoBank: 1,
  gravity: 1,
  floating: true,
  nodes: [
    n(0, 0, 0),
    n(0, 0, -140),
    n(-20, 10, -240),
    n(-100, 20, -290),
    n(-200, 20, -270),
    n(-260, 10, -190),
    n(-250, 0, -90, { bank: 90 }),
    n(-200, -5, -10, { bank: 180 }),
    n(-130, -5, 40, { bank: 180 }),
    n(-140, 0, 120, { bank: 270 }),
    n(-200, 10, 190, { bank: 360 }),
    n(-150, 20, 270),
    n(-40, 25, 300),
    n(80, 20, 280),
    n(180, 10, 300),
    n(270, 0, 230),
    n(280, -5, 120),
    n(210, -10, 40, { w: 11 }),
    n(240, 0, -60, { w: 11 }),
    n(180, 10, -160),
    n(110, 6, -110),
    n(90, 0, -20),
    n(80, 0, 80, { w: 11 }),
    n(30, 0, 150, { w: 11 }),
    n(-10, 0, 90),
  ],
  boostPads: [
    { at: 0.6, d: 0 },
    { at: 7.5, d: 0 },
    { at: 12.5, d: -0.4 },
    { at: 15.5, d: 0.4 },
    { at: 19.5, d: 0 },
    { at: 23.6, d: 0 },
  ],
  itemRows: [1.5, 8.5, 13.5, 20.6],
  coins: [
    { at: 2.3, d: 0.4, n: 5 },
    { at: 7.1, d: 0, n: 6 },
    { at: 11.3, d: -0.4, n: 5 },
    { at: 14.5, d: 0.3, n: 5 },
    { at: 17.5, d: -0.3, n: 4 },
    { at: 21.4, d: 0.4, n: 4 },
  ],
  ramps: [{ at: 12.9, lift: 14 }],
  gaps: [{ from: 13.02, to: 13.3 }],
  open: [
    { from: 3.2, to: 4.8, side: 0 },
    { from: 14.2, to: 15.2, side: 1 },
  ],
  hazards: [
    { kind: "arc", at: 2.8, period: 3.2, phase: 0 },
    { kind: "arc", at: 10.8, period: 3.6, phase: 1.2 },
    { kind: "arc", at: 16.6, period: 3, phase: 0.4 },
    { kind: "arc", at: 22.3, period: 3.4, phase: 2 },
  ],
};

/** The Moon: low gravity, huge jumps over craters, Earth on the horizon. */
const LUNA: TrackDef = {
  id: "luna",
  name: "Crater Rush",
  theme: "luna",
  blurb: "Low gravity on the Moon: big air over craters with Earth hanging in the sky. Mind the meteors.",
  accent: ["#d9e4ff", "#5ab0ff"],
  halfWidth: 13.5,
  shoulder: 6,
  autoBank: 0.5,
  gravity: 0.62,
  floating: false,
  nodes: [
    n(0, 0, 0),
    n(0, 0, -150),
    n(40, 6, -260),
    n(150, 10, -300),
    n(250, 4, -240),
    n(280, -4, -130),
    n(230, -8, -40, { w: 12 }),
    n(260, 0, 60, { w: 12 }),
    n(200, 6, 160),
    n(90, 10, 190),
    n(-10, 4, 250),
    n(-130, 0, 260),
    n(-230, 6, 190),
    n(-260, 12, 80),
    n(-200, 8, -10),
    n(-220, 4, -120),
    n(-150, 0, -200),
    n(-80, 0, -140, { w: 12.5 }),
    n(-90, 0, -40, { w: 12.5 }),
    n(-80, 0, 60),
    n(-30, 0, 90),
  ],
  boostPads: [
    { at: 0.5, d: -0.35 },
    { at: 2.45, d: 0 },
    { at: 9.3, d: 0 },
    { at: 15.3, d: 0 },
    { at: 18.5, d: 0.4 },
  ],
  itemRows: [1.4, 7.4, 12.4, 17.4],
  coins: [
    { at: 1.8, d: 0.3, n: 5 },
    { at: 4.5, d: -0.4, n: 5 },
    { at: 8.4, d: 0.4, n: 5 },
    { at: 11.2, d: 0, n: 6 },
    { at: 13.6, d: -0.5, n: 5 },
    { at: 19.3, d: 0.4, n: 4 },
  ],
  ramps: [
    { at: 2.62, lift: 16 },
    { at: 9.52, lift: 15 },
    { at: 15.55, lift: 15 },
  ],
  gaps: [
    { from: 2.76, to: 3.12 },
    { from: 9.66, to: 9.95 },
    { from: 15.7, to: 16.0 },
  ],
  open: [],
  hazards: [
    { kind: "meteor", at: 4.8, d: 0.3, period: 6, phase: 0 },
    { kind: "meteor", at: 5.3, d: -0.35, period: 6, phase: 3 },
    { kind: "meteor", at: 11.8, d: 0.2, period: 7, phase: 1.5 },
    { kind: "meteor", at: 13.4, d: -0.3, period: 6.5, phase: 4.2 },
    { kind: "meteor", at: 18.8, d: 0, period: 5.5, phase: 2.4 },
  ],
};

/** A star's corona: skimming a boiling plasma surface, a corkscrew and solar-flare strikes. */
const SUN: TrackDef = {
  id: "sun",
  name: "Solar Corona",
  theme: "sun",
  blurb: "Skim a boiling star. Dodge solar-flare strikes, corkscrew through the corona and leap a plasma gap.",
  accent: ["#ff9a2e", "#ffe066"],
  halfWidth: 12.5,
  shoulder: 2.5,
  autoBank: 1,
  gravity: 1,
  floating: true,
  nodes: [
    n(0, 0, 0),
    n(0, 4, -140),
    n(40, 14, -250),
    n(140, 24, -300),
    n(250, 18, -260),
    n(300, 6, -160),
    n(280, -8, -50),
    n(200, -14, 20, { w: 13.5 }),
    n(120, -4, -10, { w: 13.5 }),
    n(90, 10, 90),
    n(160, 24, 170, { bank: 0 }),
    n(260, 30, 230, { bank: 120 }),
    n(200, 20, 320, { bank: 240 }),
    n(80, 8, 300, { bank: 360 }),
    n(-40, 0, 280),
    n(-150, -6, 300),
    n(-250, 4, 220),
    n(-280, 16, 110),
    n(-220, 22, 10),
    n(-150, 12, -60),
    n(-100, 4, 20, { w: 12 }),
    n(-60, 0, 110, { w: 12 }),
    n(-15, 0, 90),
  ],
  boostPads: [
    { at: 0.6, d: 0 },
    { at: 4.5, d: -0.35 },
    { at: 9.4, d: 0.3 },
    { at: 13.6, d: 0 },
    { at: 17.5, d: -0.4 },
    { at: 21.3, d: 0 },
  ],
  itemRows: [1.6, 8.6, 14.4, 19.4],
  coins: [
    { at: 2.3, d: 0.4, n: 5 },
    { at: 5.2, d: -0.3, n: 5 },
    { at: 10.5, d: 0, n: 6 },
    { at: 12.4, d: 0, n: 5 },
    { at: 16.2, d: 0.4, n: 5 },
    { at: 20.4, d: -0.3, n: 4 },
  ],
  ramps: [{ at: 7.62, lift: 15 }],
  gaps: [{ from: 7.76, to: 8.08 }],
  open: [
    { from: 14.2, to: 15.8, side: 0 },
    { from: 2.4, to: 3.2, side: 1 },
  ],
  hazards: [
    { kind: "meteor", at: 3.5, d: 0.3, period: 6, phase: 0 },
    { kind: "meteor", at: 5.6, d: -0.3, period: 6.5, phase: 2.5 },
    { kind: "meteor", at: 16.6, d: 0.2, period: 5.5, phase: 1.2 },
    { kind: "arc", at: 18.7, period: 3.2, phase: 0.6 },
    { kind: "arc", at: 6.5, period: 3.6, phase: 1.8 },
  ],
};

/** Europa: Jupiter's ice moon. Low gravity, rolling ice boulders, jumps over cracked lineae. */
const EUROPA: TrackDef = {
  id: "europa",
  name: "Europa Ice",
  theme: "europa",
  blurb: "Race the cracked ice of Jupiter's moon. Low gravity, rolling ice boulders and jumps over the lineae.",
  accent: ["#7fd6ff", "#ff7a5a"],
  halfWidth: 13,
  shoulder: 6,
  autoBank: 0.6,
  gravity: 0.8,
  floating: false,
  nodes: [
    n(0, 0, 0),
    n(0, 0, -130),
    n(-30, 6, -240),
    n(-130, 12, -290),
    n(-240, 8, -240),
    n(-280, 0, -140),
    n(-230, -6, -50, { w: 12 }),
    n(-260, 0, 50, { w: 12 }),
    n(-200, 8, 150),
    n(-90, 14, 190),
    n(10, 8, 250),
    n(130, 4, 260),
    n(240, 10, 200),
    n(280, 16, 90),
    n(220, 10, 0),
    n(250, 4, -100),
    n(190, 0, -200),
    n(100, 0, -160, { w: 12.5 }),
    n(80, 0, -60, { w: 12.5 }),
    n(90, 0, 50),
    n(40, 0, 100),
  ],
  boostPads: [
    { at: 0.5, d: 0.35 },
    { at: 2.45, d: 0 },
    { at: 7.5, d: -0.3 },
    { at: 12.45, d: 0 },
    { at: 16.5, d: 0.35 },
  ],
  itemRows: [1.4, 6.4, 11.4, 17.4],
  coins: [
    { at: 1.8, d: -0.4, n: 5 },
    { at: 4.4, d: 0.3, n: 5 },
    { at: 8.4, d: 0, n: 6 },
    { at: 10.5, d: -0.3, n: 5 },
    { at: 14.4, d: 0.4, n: 5 },
    { at: 18.6, d: -0.2, n: 4 },
  ],
  ramps: [
    { at: 2.62, lift: 16 },
    { at: 12.6, lift: 15 },
  ],
  gaps: [
    { from: 2.76, to: 3.06 },
    { from: 12.74, to: 13.02 },
  ],
  open: [],
  hazards: [
    { kind: "asteroid", at: 6.5, size: 4, period: 6, phase: 0 },
    { kind: "asteroid", at: 14.6, size: 5, period: 7, phase: 2.2 },
    { kind: "asteroid", at: 19.5, size: 3.5, period: 5, phase: 1 },
    { kind: "meteor", at: 9.5, d: 0.3, period: 6.5, phase: 1.5 },
    { kind: "meteor", at: 17.3, d: -0.3, period: 6, phase: 3.3 },
  ],
};

export const TRACKS: readonly TrackDef[] = [MARS, BELT, SATURN, NEBULA, LUNA, SUN, EUROPA];

/** The same course in mirror image (left turns become right turns). */
export function mirrorTrack(def: TrackDef): TrackDef {
  const flip = <T extends { d: number }>(x: T): T => ({ ...x, d: -x.d });
  return {
    ...def,
    id: `${def.id}-mirror`,
    name: `${def.name} (Mirror)`,
    nodes: def.nodes.map((node) => ({ ...node, p: [-node.p[0], node.p[1], node.p[2]] as const, bank: node.bank === undefined ? undefined : -node.bank })),
    boostPads: def.boostPads.map(flip),
    coins: def.coins.map(flip),
    open: def.open.map((o) => ({ ...o, side: (o.side === 0 ? 0 : -o.side) as -1 | 0 | 1 })),
    hazards: def.hazards.map((h) => (h.kind === "meteor" ? { ...h, d: -h.d } : h)),
  };
}

const mirrors = new Map<string, TrackDef>();
export function mirrored(def: TrackDef): TrackDef {
  let m = mirrors.get(def.id);
  if (!m) {
    m = mirrorTrack(def);
    mirrors.set(def.id, m);
  }
  return m;
}

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? ARENAS.find((t) => t.id === id) ?? MARS;
}

export interface Cup {
  id: string;
  name: string;
  icon: string;
  tracks: readonly string[];
}

export const CUPS: readonly Cup[] = [
  { id: "solar", name: "Solar Cup", icon: "☀️", tracks: ["mars", "belt", "saturn"] },
  { id: "void", name: "Void Cup", icon: "🌌", tracks: ["nebula", "luna", "europa"] },
  { id: "star", name: "Star Cup", icon: "🌟", tracks: ["sun", "europa", "nebula"] },
  { id: "grand", name: "Galaxy Cup", icon: "🪐", tracks: ["mars", "saturn", "sun", "europa"] },
];

/** A lumpy ring of nodes for a battle bowl. */
function bowl(radius: number, wobble: number, lift: number, count = 12, seed = 1): TrackNode[] {
  return Array.from({ length: count }, (_, k) => {
    const a = (k / count) * Math.PI * 2;
    const r = radius + Math.sin(a * 3 + seed) * wobble + Math.cos(a * 2 - seed) * wobble * 0.5;
    return n(Math.sin(a) * r, Math.sin(a * 2 + seed) * lift, -Math.cos(a) * r);
  });
}

const arenaBase = {
  shoulder: 2,
  autoBank: 1.2,
  gravity: 1,
  arena: true,
  gaps: [],
  open: [],
  ramps: [],
} as const;

/** Battle arenas: short, wide bowls where everyone meets again and again. */
export const ARENAS: readonly TrackDef[] = [
  {
    ...arenaBase,
    id: "arena-crater",
    name: "Crater Bowl",
    theme: "luna",
    blurb: "A lunar crater ringed with ramps. Three orbs each; last ship flying wins.",
    accent: ["#d9e4ff", "#5ab0ff"],
    halfWidth: 22,
    floating: false,
    gravity: 0.62,
    nodes: bowl(120, 18, 6, 12, 0.4),
    boostPads: [{ at: 1.5, d: 0 }, { at: 4.5, d: 0.5 }, { at: 7.5, d: -0.5 }, { at: 10.5, d: 0 }],
    itemRows: [0.5, 2.5, 4.5, 6.5, 8.5, 10.5],
    coins: [{ at: 1, d: -0.5, n: 4 }, { at: 5, d: 0.5, n: 4 }, { at: 9, d: 0, n: 4 }],
    ramps: [{ at: 3.5, lift: 13 }, { at: 9.5, lift: 13 }],
    hazards: [{ kind: "meteor", at: 6, d: 0, period: 7, phase: 2 }],
  },
  {
    ...arenaBase,
    id: "arena-dust",
    name: "Dust Bowl",
    theme: "mars",
    blurb: "A Martian dust bowl with roaming dust devils. Three orbs each; last ship flying wins.",
    accent: ["#ff8a4c", "#ffd166"],
    halfWidth: 22,
    floating: false,
    nodes: bowl(115, 22, 4, 12, 1.7),
    boostPads: [{ at: 0.5, d: 0 }, { at: 3.5, d: 0.4 }, { at: 6.5, d: -0.4 }, { at: 9.5, d: 0 }],
    itemRows: [1, 3, 5, 7, 9, 11],
    coins: [{ at: 2, d: 0.4, n: 4 }, { at: 6, d: -0.4, n: 4 }, { at: 10, d: 0, n: 4 }],
    hazards: [
      { kind: "dust", at: 2.5, period: 5, phase: 0 },
      { kind: "dust", at: 8.5, period: 6, phase: 2 },
    ],
  },
  {
    ...arenaBase,
    id: "arena-neon",
    name: "Neon Colosseum",
    theme: "nebula",
    blurb: "A floating neon ring in the nebula, banked and fast. Three orbs each; last ship flying wins.",
    accent: ["#ff4fd8", "#36f3ff"],
    halfWidth: 20,
    floating: true,
    nodes: bowl(110, 14, 10, 12, 2.9),
    boostPads: [{ at: 1, d: 0 }, { at: 4, d: 0 }, { at: 7, d: 0 }, { at: 10, d: 0 }],
    itemRows: [0.5, 2.5, 4.5, 6.5, 8.5, 10.5],
    coins: [{ at: 1.5, d: 0.5, n: 4 }, { at: 5.5, d: -0.5, n: 4 }, { at: 9.5, d: 0, n: 4 }],
    hazards: [
      { kind: "arc", at: 3, period: 3.4, phase: 0 },
      { kind: "arc", at: 9, period: 3, phase: 1.5 },
    ],
  },
];
