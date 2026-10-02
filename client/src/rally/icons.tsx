/**
 * Item icons, drawn as chunky glossy SVG badges (no emoji, no assets).
 */

import type { ItemId } from "./items";

function Nitro({ count = 1 }: { count?: number }) {
  const cans = Array.from({ length: count }, (_, i) => i);
  return (
    <g>
      {cans.map((i) => {
        const x = count === 1 ? 32 : 18 + i * 14;
        const s = count === 1 ? 1 : 0.72;
        return (
          <g key={i} transform={`translate(${x} ${count === 1 ? 32 : 34 - (i % 2) * 4}) scale(${s})`}>
            <path d="M-6 -24 L6 -24 L10 -16 L10 20 Q10 26 4 26 L-4 26 Q-10 26 -10 20 L-10 -16 Z" fill="url(#nr-orange)" stroke="#5a1e00" strokeWidth="3" />
            <rect x="-6" y="-30" width="12" height="8" rx="2" fill="#dfe6f0" stroke="#3a3f4a" strokeWidth="2.5" />
            <path d="M-3 -8 L4 -8 L-1 2 L5 2 L-4 16 L-1 5 L-6 5 Z" fill="#fff6c9" />
            <path d="M-7 -14 L-7 18" stroke="#fff" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" />
          </g>
        );
      })}
    </g>
  );
}

function Seeker() {
  return (
    <g transform="translate(32 32) rotate(-35)">
      <path d="M-22 0 L-12 -7 L-12 7 Z" fill="#ffb347" />
      <path d="M-30 0 L-20 -4 L-20 4 Z" fill="#ffe8a0" />
      <rect x="-14" y="-7" width="30" height="14" rx="6" fill="url(#nr-steel)" stroke="#262a33" strokeWidth="3" />
      <path d="M16 -7 Q30 0 16 7 Z" fill="url(#nr-red)" stroke="#5a0010" strokeWidth="3" />
      <path d="M-10 -7 L-16 -15 L-4 -7 Z M-10 7 L-16 15 L-4 7 Z" fill="url(#nr-red)" stroke="#5a0010" strokeWidth="2.5" />
      <circle cx="6" cy="0" r="3" fill="#ff3d5a" />
    </g>
  );
}

function Bolt({ count = 1 }: { count?: number }) {
  const pos = count === 1 ? [[32, 32, 1]] : [
    [20, 38, 0.62],
    [44, 38, 0.62],
    [32, 20, 0.62],
  ];
  return (
    <g>
      {pos.map(([x, y, s], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
          <circle r="20" fill="url(#nr-green)" stroke="#004a25" strokeWidth="3" />
          <ellipse rx="26" ry="8" fill="none" stroke="#c9ffe2" strokeWidth="3" transform="rotate(-20)" />
          <circle cx="-6" cy="-7" r="5" fill="#fff" fillOpacity="0.7" />
        </g>
      ))}
    </g>
  );
}

function Mine() {
  const spikes = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
  return (
    <g transform="translate(32 33)">
      {spikes.map((a, i) => (
        <path key={i} d="M-4 -14 L0 -26 L4 -14 Z" fill="#ffe23d" stroke="#6b5200" strokeWidth="2" transform={`rotate(${(a * 180) / Math.PI})`} />
      ))}
      <circle r="16" fill="url(#nr-dark)" stroke="#16161d" strokeWidth="3" />
      <circle r="6" fill="#ffe23d" />
      <circle cx="-5" cy="-6" r="3" fill="#fff" fillOpacity="0.5" />
    </g>
  );
}

function Shield() {
  return (
    <g transform="translate(32 32)">
      <path d="M0 -26 L22 -13 L22 13 L0 26 L-22 13 L-22 -13 Z" fill="url(#nr-blue)" stroke="#003a63" strokeWidth="3" />
      <path d="M0 -16 L13 -8 L13 8 L0 16 L-13 8 L-13 -8 Z" fill="none" stroke="#dff5ff" strokeWidth="3" strokeOpacity="0.8" />
      <path d="M-14 -12 L-6 -17" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.7" />
    </g>
  );
}

function Emp() {
  return (
    <g transform="translate(32 32)">
      <circle r="24" fill="url(#nr-purple)" stroke="#2c0a5a" strokeWidth="3" />
      <path d="M4 -20 L-10 3 L-1 3 L-6 20 L10 -4 L1 -4 Z" fill="#fff7a8" stroke="#6b4a00" strokeWidth="2" strokeLinejoin="round" />
      <circle r="28" fill="none" stroke="#d5b3ff" strokeWidth="2" strokeDasharray="5 6" />
    </g>
  );
}

function Singularity() {
  return (
    <g transform="translate(32 32)">
      <ellipse rx="28" ry="11" fill="none" stroke="url(#nr-disk)" strokeWidth="7" transform="rotate(-18)" />
      <circle r="13" fill="#05030a" stroke="#b18cff" strokeWidth="2.5" />
      <path d="M-24 4 Q0 -14 24 -4" fill="none" stroke="#ffd0ff" strokeWidth="3" strokeLinecap="round" transform="rotate(-18)" />
    </g>
  );
}

function Warp() {
  return (
    <g transform="translate(32 32) rotate(-35)">
      {[-10, 0, 10].map((y) => (
        <path key={y} d={`M-30 ${y} L-14 ${y}`} stroke="#ffc3f0" strokeWidth="3" strokeLinecap="round" />
      ))}
      <path d="M-12 -10 L10 -10 Q26 0 10 10 L-12 10 Z" fill="url(#nr-pink)" stroke="#5a0040" strokeWidth="3" />
      <path d="M-12 -10 L-20 -18 L-4 -10 Z M-12 10 L-20 18 L-4 10 Z" fill="#ff5ad1" stroke="#5a0040" strokeWidth="2.5" />
      <circle cx="6" cy="-1" r="4" fill="#fff" />
    </g>
  );
}

function Cloak() {
  return (
    <g transform="translate(32 33)">
      <path d="M-20 18 L-20 -4 Q-20 -24 0 -24 Q20 -24 20 -4 L20 18 L13 12 L7 18 L0 12 L-7 18 L-13 12 Z" fill="url(#nr-ghost)" stroke="#39406a" strokeWidth="3" strokeLinejoin="round" />
      <ellipse cx="-7" cy="-6" rx="4" ry="6" fill="#1b1f3a" />
      <ellipse cx="7" cy="-6" rx="4" ry="6" fill="#1b1f3a" />
      <circle cx="-6" cy="-8" r="1.6" fill="#fff" />
      <circle cx="8" cy="-8" r="1.6" fill="#fff" />
    </g>
  );
}

function Defs() {
  const grad = (id: string, a: string, b: string) => (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
  );
  return (
    <defs>
      {grad("nr-orange", "#ffd36b", "#ff6a1a")}
      {grad("nr-red", "#ff7a8a", "#d2102e")}
      {grad("nr-steel", "#ffffff", "#9aa3b5")}
      {grad("nr-green", "#b8ffd4", "#12c46a")}
      {grad("nr-dark", "#6a6a78", "#1c1c24")}
      {grad("nr-blue", "#a8e6ff", "#1b8bff")}
      {grad("nr-purple", "#c79bff", "#5a1ec8")}
      {grad("nr-pink", "#ffd0f3", "#ff3dbf")}
      {grad("nr-ghost", "#ffffff", "#b9c4ff")}
      <linearGradient id="nr-disk" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#ff9af0" />
        <stop offset="0.5" stopColor="#8a5cff" />
        <stop offset="1" stopColor="#59e0ff" />
      </linearGradient>
    </defs>
  );
}

export function ItemIcon({ id, className }: { id: ItemId; className?: string }) {
  let body: React.ReactNode;
  switch (id) {
    case "nitro":
      body = <Nitro />;
      break;
    case "nitro3":
      body = <Nitro count={3} />;
      break;
    case "seeker":
      body = <Seeker />;
      break;
    case "bolt":
      body = <Bolt />;
      break;
    case "bolt3":
      body = <Bolt count={3} />;
      break;
    case "mine":
      body = <Mine />;
      break;
    case "shield":
      body = <Shield />;
      break;
    case "emp":
      body = <Emp />;
      break;
    case "singularity":
      body = <Singularity />;
      break;
    case "warp":
      body = <Warp />;
      break;
    case "cloak":
      body = <Cloak />;
      break;
  }
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <Defs />
      {body}
    </svg>
  );
}

/** A spinning star token (stardust coin). */
export function CoinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="nr-coin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff2a8" />
          <stop offset="1" stopColor="#ffab1a" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="14" fill="url(#nr-coin)" stroke="#8a5200" strokeWidth="2.5" />
      <path d="M16 6 L18.6 12.6 L25.5 13 L20.2 17.4 L21.9 24.2 L16 20.4 L10.1 24.2 L11.8 17.4 L6.5 13 L13.4 12.6 Z" fill="#fff" fillOpacity="0.9" />
    </svg>
  );
}
