"use client";

/**
 * Twin-stick phone controls: a floating stick on the left (appears under
 * your thumb; push it to the edge to sprint), drag anywhere on the right to
 * look, and buttons for fire (drag it to keep aiming while you shoot), aim,
 * reload, jump, crouch and swap. Every touch surface is gesture-locked so
 * the page never scrolls or zooms mid-fight.
 */

import { useGestureLock } from "@xapps/sdk/react";
import { ArrowUpFromLine, Bomb, ChevronsDown, Crosshair, RotateCw, Scan } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Engine } from "./engine";
import type { HudState } from "./game";
import { GunGlyph } from "./loadout";

const RADIUS = 52;

export function TouchControls({ engine, hud }: { engine: Engine; hud: HudState }) {
  const root = useRef<HTMLDivElement>(null);
  useGestureLock(root);
  const [stick, setStick] = useState<{ ox: number; oy: number; x: number; y: number } | null>(null);
  const [ads, setAds] = useState(false);
  const [crouch, setCrouch] = useState(false);
  const stickId = useRef<number | null>(null);

  const me = hud.me;
  const active = !!me && me.alive && hud.phase === "live";
  const input = engine.input;

  // A finger can still be down when the controls go away (death, round end,
  // pause): the browser never sends its pointerup here, so drop everything it
  // held. They remount fresh on every death, respawn and phase (see the key in hud.tsx).
  useEffect(() => {
    if (active) return;
    stickId.current = null;
    input.release();
  }, [active, input]);
  useEffect(
    () => () => {
      stickId.current = null;
      input.release();
    },
    [input],
  );
  const endStick = () => {
    stickId.current = null;
    setStick(null);
    input.setTouch({ mx: 0, my: 0 });
  };

  const capture = (e: ReactPointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events can't be captured
    }
  };

  const lookStart = (e: ReactPointerEvent) => {
    capture(e);
    input.lookStart(e.pointerId, e.clientX, e.clientY);
    engine.audio.resume();
  };
  const lookMove = (e: ReactPointerEvent) => input.lookMove(e.pointerId, e.clientX, e.clientY);
  const lookEnd = (e: ReactPointerEvent) => input.lookEnd(e.pointerId);

  const press = (on: (down: boolean) => void, look = false) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      capture(e);
      on(true);
      if (look) input.lookStart(e.pointerId, e.clientX, e.clientY);
      engine.audio.resume();
    },
    onPointerMove: look ? lookMove : undefined,
    onPointerUp: (e: ReactPointerEvent) => {
      on(false);
      lookEnd(e);
    },
    onPointerCancel: (e: ReactPointerEvent) => {
      on(false);
      lookEnd(e);
    },
  });

  // Aim + fire in one touch (mobile shooters' "ADS fire"): automatic and other
  // guns aim down sights and shoot while held; the sniper scopes in while held
  // and fires on release (a quick-scope). Dragging on it aims, like Fire.
  const sniper = me?.weapon === "sniper";
  const aimFire = (down: boolean) => {
    if (down) input.setTouch({ ads: true, fire: !sniper });
    else if (sniper) input.pulseFire({ ads });
    else input.setTouch({ fire: false, ads });
  };

  const tap = (fn: () => void) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    },
  });

  const stickMove = (e: ReactPointerEvent, origin: { ox: number; oy: number }) => {
    let dx = e.clientX - origin.ox;
    let dy = e.clientY - origin.oy;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      dx = (dx / d) * RADIUS;
      dy = (dy / d) * RADIUS;
    }
    setStick({ ...origin, x: dx, y: dy });
    input.setTouch({ mx: dx / RADIUS, my: -dy / RADIUS });
  };

  return (
    <div ref={root} className={cn("absolute inset-x-0 bottom-0 top-[22%] touch-none select-none", active ? "pointer-events-auto" : "pointer-events-none hidden")}>
      {me && active && (
        <>
      {/* Look: the right side. */}
      <div className="absolute inset-y-0 right-0 w-[58%]" onPointerDown={lookStart} onPointerMove={lookMove} onPointerUp={lookEnd} onPointerCancel={lookEnd} />
      {/* Move: a floating stick on the left. */}
      <div
        className="absolute inset-y-0 left-0 w-[42%]"
        onPointerDown={(e) => {
          // A new thumb always takes the stick (never locked out by a lost touch).
          stickId.current = e.pointerId;
          capture(e);
          setStick({ ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
          engine.audio.resume();
        }}
        onPointerMove={(e) => {
          if (e.pointerId !== stickId.current || !stick) return;
          stickMove(e, stick);
        }}
        onPointerUp={(e) => {
          if (e.pointerId === stickId.current) endStick();
        }}
        onPointerCancel={(e) => {
          if (e.pointerId === stickId.current) endStick();
        }}
        onLostPointerCapture={(e) => {
          if (e.pointerId === stickId.current) endStick();
        }}
      />
      {stick ? (
        <div className="pointer-events-none fixed" style={{ left: stick.ox, top: stick.oy }}>
          <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/25 bg-white/5" style={{ width: RADIUS * 2 + 28, height: RADIUS * 2 + 28 }} />
          <div
            className={cn("absolute size-14 rounded-full border border-white/40 backdrop-blur", Math.hypot(stick.x, stick.y) > RADIUS * 0.93 && stick.y < 0 ? "bg-[var(--accent-from)]/50" : "bg-white/25")}
            style={{ transform: `translate(calc(-50% + ${stick.x}px), calc(-50% + ${stick.y}px))` }}
          />
        </div>
      ) : (
        <div className="pointer-events-none absolute bottom-[max(2.5rem,env(safe-area-inset-bottom))] left-8 flex size-28 items-center justify-center rounded-full border-2 border-dashed border-white/15">
          <div className="size-12 rounded-full bg-white/10" />
        </div>
      )}

      {/* Buttons. */}
      <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-3 grid grid-cols-[auto_auto_auto] items-end gap-2.5">
        <div />
        <Btn label="Swap weapon" size="sm" {...tap(() => input.setTouch({ swap: true }))}>
          <GunGlyph id={me.weapons[me.slot === 0 ? 1 : 0]} className="h-4 w-9" />
        </Btn>
        <Btn label="Jump" size="sm" {...tap(() => input.setTouch({ jump: true }))}>
          <ArrowUpFromLine className="size-5" />
        </Btn>
        <Btn label="Reload" size="sm" {...tap(() => input.setTouch({ reload: true }))} className={me.mag === 0 ? "animate-pulse border-[#ff6a5a]" : undefined}>
          <RotateCw className="size-5" />
        </Btn>
        <Btn
          label="Crouch"
          size="sm"
          on={crouch}
          {...tap(() => {
            input.setTouch({ crouch: !crouch });
            setCrouch(!crouch);
          })}
        >
          <ChevronsDown className="size-5" />
        </Btn>
        <Btn
          label="Aim down sights"
          size="md"
          on={ads}
          {...tap(() => {
            input.setTouch({ ads: !ads });
            setAds(!ads);
          })}
        >
          <Scan className="size-6" />
        </Btn>
        <Btn
          label="Grenade (hold to aim, release to throw)"
          size="sm"
          className={me.nades > 0 ? undefined : "opacity-35"}
          {...press((down) => input.setTouch({ grenade: down && me.nades > 0 }), true)}
        >
          <Bomb className="size-5" />
        </Btn>
        <Btn
          label={me.weapon === "sniper" ? "Aim and fire: hold to scope in, release to fire" : "Aim and fire: hold to aim down sights and shoot"}
          size="md"
          className="bg-[color-mix(in_oklab,var(--accent-to)_28%,transparent)]"
          {...press((down) => aimFire(down), true)}
        >
          <span className="relative">
            <Scan className="size-7" />
            <Crosshair className="absolute inset-0 m-auto size-3.5" />
          </span>
        </Btn>
        <Btn label="Fire" size="lg" {...press((down) => input.setTouch({ fire: down }), true)} className="bg-[color-mix(in_oklab,var(--accent-to)_40%,transparent)]">
          <Crosshair className="size-9" />
        </Btn>
      </div>
        </>
      )}
    </div>
  );
}

function Btn({
  label,
  size,
  on,
  className,
  children,
  ...handlers
}: {
  label: string;
  size: "sm" | "md" | "lg";
  on?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      {...handlers}
      className={cn(
        "flex items-center justify-center rounded-full border border-white/25 bg-ink-900/55 text-white backdrop-blur active:scale-95",
        size === "sm" ? "size-12" : size === "md" ? "size-16" : "size-24",
        on && "border-[var(--accent-from)] bg-[color-mix(in_oklab,var(--accent-from)_35%,transparent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}
