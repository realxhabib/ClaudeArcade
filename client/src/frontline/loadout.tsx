"use client";

/**
 * The loadout picker: four primaries (with a side-view silhouette and stat
 * bars), the sidearm everyone carries, and one perk. Used full-size before
 * the match and compact on the death screen (applies from the next spawn).
 */

import { motion } from "motion/react";
import { Check } from "lucide-react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PERKS, PERK_IDS, PRIMARIES, WEAPONS, type Loadout, type PerkId, type WeaponId } from "./weapons";

/** Side views drawn from rectangles, 120 × 40. */
export function GunGlyph({ id, className }: { id: WeaponId; className?: string }) {
  const body = "currentColor";
  const shapes: Record<WeaponId, React.ReactNode> = {
    ar: (
      <>
        <rect x="30" y="14" width="46" height="9" rx="1.5" fill={body} />
        <rect x="76" y="15.5" width="26" height="6" rx="1" fill={body} opacity="0.85" />
        <rect x="102" y="17" width="14" height="2.6" fill={body} />
        <rect x="6" y="15" width="26" height="7" rx="2" fill={body} opacity="0.85" />
        <path d="M52 23 L62 23 L64 36 L56 37 Z" fill={body} opacity="0.9" />
        <path d="M36 23 L43 23 L41 33 L35 33 Z" fill={body} />
        <rect x="40" y="11" width="30" height="2.6" fill={body} />
      </>
    ),
    smg: (
      <>
        <rect x="34" y="14" width="40" height="10" rx="1.5" fill={body} />
        <rect x="74" y="16.5" width="14" height="5" fill={body} />
        <rect x="14" y="16" width="22" height="4" fill={body} opacity="0.8" />
        <rect x="56" y="24" width="7" height="14" rx="1" fill={body} opacity="0.9" />
        <path d="M40 24 L47 24 L45 34 L39 34 Z" fill={body} />
      </>
    ),
    sniper: (
      <>
        <rect x="26" y="16" width="46" height="8" rx="1.5" fill={body} />
        <rect x="72" y="18" width="44" height="3.2" fill={body} />
        <path d="M4 16 L28 17 L28 24 L6 27 Z" fill={body} opacity="0.85" />
        <rect x="36" y="7" width="30" height="6" rx="3" fill={body} />
        <rect x="46" y="13" width="3" height="3" fill={body} />
        <path d="M34 24 L41 24 L39 33 L33 33 Z" fill={body} />
      </>
    ),
    shotgun: (
      <>
        <rect x="32" y="14" width="36" height="9" rx="1.5" fill={body} />
        <rect x="68" y="14.5" width="48" height="4" fill={body} />
        <rect x="70" y="19" width="30" height="4.5" rx="1.5" fill={body} opacity="0.85" />
        <path d="M6 16 L34 15 L34 22 L8 27 Z" fill={body} opacity="0.85" />
        <path d="M38 23 L45 23 L43 33 L37 33 Z" fill={body} />
      </>
    ),
    pistol: (
      <>
        <rect x="44" y="13" width="36" height="8" rx="1.5" fill={body} />
        <path d="M48 21 L58 21 L55 36 L46 36 Z" fill={body} opacity="0.9" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 120 40" className={className} aria-hidden>
      {shapes[id]}
    </svg>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-[linear-gradient(90deg,var(--accent-from),var(--accent-to))]" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </div>
  );
}

export function LoadoutPicker({
  value,
  onChange,
  compact = false,
  disabled = false,
  keys = false,
}: {
  value: Loadout;
  onChange: (l: Loadout) => void;
  compact?: boolean;
  disabled?: boolean;
  /** Show the number key for each primary. */
  keys?: boolean;
}) {
  const pickPrimary = (id: WeaponId) => onChange({ ...value, primary: id });
  const pickPerk = (id: PerkId) => onChange({ ...value, perk: id });
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-2" : "gap-4")}>
      <div role="radiogroup" aria-label="Primary weapon" className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-2")}>
        {PRIMARIES.map((id, i) => {
          const w = WEAPONS[id];
          const on = value.primary === id;
          return (
            <motion.button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${w.name}, ${w.kind}`}
              disabled={disabled}
              whileTap={{ scale: 0.97 }}
              transition={spring.snappy}
              onClick={() => pickPrimary(id)}
              className={cn(
                "relative flex flex-col rounded-2xl border text-left transition-colors disabled:opacity-60",
                compact ? "items-center gap-0.5 px-1.5 py-2" : "gap-2 p-3",
                on ? "border-[var(--accent-from)] bg-[color-mix(in_oklab,var(--accent-from)_14%,transparent)]" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]",
              )}
            >
              {on && !compact && (
                <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-[var(--accent-from)] text-ink-950">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
              )}
              <GunGlyph id={id} className={cn("text-ink-100", compact ? "h-5 w-full" : "h-9 w-full")} />
              {keys && <span className="absolute left-1.5 top-1 font-mono text-[9px] text-ink-400">{i + 1}</span>}
              {compact ? (
                <span className="truncate text-[10px] font-bold uppercase tracking-wide">{w.kind.split(" ")[0]}</span>
              ) : (
                <>
                  <span>
                    <span className="block text-sm font-extrabold tracking-tight">{w.name}</span>
                    <span className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400">{w.kind}</span>
                  </span>
                  <span className="flex flex-col gap-1">
                    <Bar label="Damage" value={w.card.damage} />
                    <Bar label="Range" value={w.card.range} />
                    <Bar label="Rate" value={w.card.rate} />
                    <Bar label="Mobility" value={w.card.mobility} />
                  </span>
                  <span className="hidden text-[11px] leading-snug text-ink-300 sm:block">{w.blurb}</span>
                </>
              )}
            </motion.button>
          );
        })}
      </div>
      {!compact && (
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <GunGlyph id="pistol" className="h-6 w-14 text-ink-200" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold">{WEAPONS.pistol.name}</span>
            <span className="block text-[11px] text-ink-400">Sidearm, always carried · 2 or Q to swap</span>
          </span>
        </div>
      )}
      <div role="radiogroup" aria-label="Perk" className="grid grid-cols-3 gap-2">
        {PERK_IDS.map((id) => {
          const on = value.perk === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pickPerk(id)}
              className={cn(
                "rounded-xl border px-2 text-left transition-colors disabled:opacity-60",
                compact ? "py-1.5" : "py-2",
                on ? "border-[var(--accent-to)] bg-[color-mix(in_oklab,var(--accent-to)_14%,transparent)]" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]",
              )}
            >
              <span className="block text-xs font-bold">{PERKS[id].name}</span>
              {!compact && <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-400">{PERKS[id].blurb}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
