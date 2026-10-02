"use client";

/**
 * A Grand Prix in progress: owns the runtime and the 3D scene, runs the frame
 * loop, reads the controls (keyboard, gamepad, touch), draws the minimap and
 * name tags, and lays the HUD on top.
 */

import { lockGestures } from "@xapps/sdk";
import { useMatchResult, useRoomEvent, useXApps } from "@xapps/sdk/react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { RaceHud } from "./hud";
import { RaceRuntime, type ArcadeRace, type ShipChoice } from "./race";
import { RaceScene, detectQuality } from "./scene";
import type { CompiledTrack } from "./track";

interface Keys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  drift: boolean;
  back: boolean;
}

interface Touch {
  steerId: number | null;
  steerX0: number;
  steer: number;
  drift: boolean;
  brake: boolean;
}

export function MatchView({
  choice,
  trial,
  arcade,
  onExit,
  onRetry,
  onRuntime,
}: {
  choice: ShipChoice;
  trial?: string;
  arcade?: ArcadeRace;
  onExit?: () => void;
  onRetry?: () => void;
  /** Hands the runtime to whoever reads its numbers (Claude Arcade's status line). */
  onRuntime?: (rt: RaceRuntime | null) => void;
}) {
  const xapps = useXApps();
  const reduced = useReducedMotion() ?? false;
  const result = useMatchResult();
  const [rt] = useState(() => new RaceRuntime(xapps, reduced, choice, { trial, arcade }));
  useEffect(() => {
    onRuntime?.(rt);
    return () => onRuntime?.(null);
  }, [rt, onRuntime]);
  const hud = useSyncExternalStore(rt.subscribe, rt.getSnapshot, rt.getSnapshot);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const tagRefs = useRef(new Map<number, HTMLDivElement>());
  const keys = useRef<Keys>({ left: false, right: false, up: false, down: false, drift: false, back: false });
  const touch = useRef<Touch>({ steerId: null, steerX0: 0, steer: 0, drift: false, brake: false });
  const [isTouch] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches);
  const [webglError, setWebglError] = useState(false);
  const [steerKnob, setSteerKnob] = useState(0);

  useRoomEvent("st", (p, from) => rt.onRemoteState(p, from));
  useRoomEvent("hi", (p, from) => rt.onRemoteHello(p, from));
  useRoomEvent("go", (p) => rt.onRemoteGo(p));
  useRoomEvent("fin", (p) => rt.onRemoteFinish(p));
  useRoomEvent("res", (p) => rt.onRemoteResults(p));
  useRoomEvent("fx", (p, from) => rt.onRemoteFx(p, from));

  useEffect(() => {
    if (result) rt.onResult(result);
  }, [result, rt]);

  useEffect(() => xapps.room.onPresence((online) => rt.onPresence(online)), [xapps, rt]);

  // Scene + frame loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let scene: RaceScene;
    try {
      scene = new RaceScene(canvas, rt, reduced, detectQuality());
    } catch (error) {
      console.error("[nova-rally] WebGL unavailable", error);
      queueMicrotask(() => setWebglError(true));
      return;
    }
    rt.attach();
    // Debug hook for automated captures: /embed/nova-rally?nr-debug
    if (new URLSearchParams(window.location.search).has("nr-debug")) Object.assign(window as unknown as object, { __novaRally: rt, __novaScene: scene });
    const resize = () => {
      const r = stage.getBoundingClientRect();
      scene.resize(r.width, r.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    void rt.start();
    let raf = 0;
    let last = performance.now();
    let steer = 0;
    let firePad = false;
    let driftPad = false;
    let mapTrack: CompiledTrack | null = null;
    let mapPath: Path2D | null = null;
    let mapFit = { x: 0, z: 0, k: 1 };
    // HUD panels name tags must not sit on (re-measured twice a second).
    let blocks: DOMRect[] = [];
    let blocksAt = -1;
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      // Controls.
      const k = keys.current;
      const t = touch.current;
      let pad = { steer: 0, throttle: 0, brake: 0, drift: false, fire: false, back: false };
      const gp = typeof navigator !== "undefined" && navigator.getGamepads ? [...navigator.getGamepads()].find((g) => g && g.connected) : null;
      if (gp) {
        const ax = gp.axes[0] ?? 0;
        const b = (i: number) => !!gp.buttons[i]?.pressed;
        const v = (i: number) => gp.buttons[i]?.value ?? 0;
        pad = {
          steer: Math.abs(ax) > 0.12 ? ax : (b(15) ? 1 : 0) - (b(14) ? 1 : 0),
          throttle: Math.max(b(0) ? 1 : 0, v(7)),
          brake: Math.max(b(1) ? 1 : 0, v(6)),
          drift: b(5) || b(2),
          fire: b(4) || b(3),
          back: b(9) ? false : b(8),
        };
        if (pad.fire && !firePad) rt.fire();
        firePad = pad.fire;
        if (pad.drift !== driftPad) rt.audio.resume();
        driftPad = pad.drift;
      }
      const keySteer = (k.right ? 1 : 0) - (k.left ? 1 : 0);
      const target = Math.max(-1, Math.min(1, keySteer + pad.steer + t.steer));
      steer += (target - steer) * Math.min(1, dt * (target === 0 ? 14 : 9));
      const auto = isTouch;
      rt.input = {
        steer,
        throttle: Math.max(k.up ? 1 : 0, pad.throttle, auto && !t.brake ? 1 : 0),
        brake: Math.max(k.down ? 1 : 0, pad.brake, t.brake ? 1 : 0),
        drift: k.drift || pad.drift || t.drift,
        lookBack: k.back || pad.back,
      };
      rt.frame(dt);
      scene.frame(dt);

      // Name tags.
      if (now - blocksAt > 500) {
        blocksAt = now;
        blocks = [...document.querySelectorAll("[data-nr-block]")].map((b) => b.getBoundingClientRect());
      }
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      for (const tag of scene.tags()) {
        const el = tagRefs.current.get(tag.idx);
        if (!el) continue;
        const tx = tag.x + (canvasRect?.left ?? 0);
        const ty = tag.y + (canvasRect?.top ?? 0);
        const covered = blocks.some((b) => tx > b.left - 40 && tx < b.right + 40 && ty > b.top - 8 && ty < b.bottom + 30);
        el.style.opacity = tag.visible && !covered ? String(Math.max(0.35, 1 - tag.dist / 90)) : "0";
        if (tag.visible) el.style.transform = `translate(${tag.x}px, ${tag.y}px) translate(-50%, -100%) scale(${Math.max(0.7, 1.2 - tag.dist / 80)})`;
      }
      if (flashRef.current) flashRef.current.style.opacity = String(rt.empFlash * 0.22);

      // Minimap.
      const mini = miniRef.current;
      if (mini) {
        const ctx = mini.getContext("2d");
        const track = rt.track;
        if (ctx) {
          const W = mini.width;
          const H = mini.height;
          if (mapTrack !== track) {
            mapTrack = track;
            let minX = Infinity;
            let maxX = -Infinity;
            let minZ = Infinity;
            let maxZ = -Infinity;
            for (let i = 0; i < track.count; i++) {
              const x = track.pos[i * 3]!;
              const z = track.pos[i * 3 + 2]!;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minZ = Math.min(minZ, z);
              maxZ = Math.max(maxZ, z);
            }
            const kk = (Math.min(W, H) * 0.84) / Math.max(maxX - minX, maxZ - minZ);
            mapFit = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, k: kk };
            mapPath = new Path2D();
            for (let i = 0; i <= track.count; i += 4) {
              const j = i % track.count;
              const x = W / 2 + (track.pos[j * 3]! - mapFit.x) * kk;
              const y = H / 2 + (track.pos[j * 3 + 2]! - mapFit.z) * kk;
              if (i === 0) mapPath.moveTo(x, y);
              else mapPath.lineTo(x, y);
            }
            mapPath.closePath();
          }
          ctx.clearRect(0, 0, W, H);
          if (mapPath) {
            ctx.lineJoin = "round";
            ctx.strokeStyle = "rgba(10,6,30,0.8)";
            ctx.lineWidth = 12;
            ctx.stroke(mapPath);
            ctx.strokeStyle = "rgba(255,255,255,0.92)";
            ctx.lineWidth = 6;
            ctx.stroke(mapPath);
            ctx.strokeStyle = track.def.accent[0];
            ctx.lineWidth = 2.5;
            ctx.stroke(mapPath);
          }
          const sorted = [...rt.racers].sort((a, b) => (a.isMe ? 1 : 0) - (b.isMe ? 1 : 0) || b.place - a.place);
          for (const r of sorted) {
            const x = W / 2 + (r.ship.pos.x - mapFit.x) * mapFit.k;
            const y = H / 2 + (r.ship.pos.z - mapFit.z) * mapFit.k;
            ctx.beginPath();
            ctx.arc(x, y, r.isMe ? 7 : 5, 0, Math.PI * 2);
            ctx.fillStyle = r.livery.glow;
            ctx.fill();
            ctx.lineWidth = r.isMe ? 3 : 2;
            ctx.strokeStyle = r.isMe ? "#fff" : "rgba(10,6,30,0.9)";
            ctx.stroke();
          }
          for (const p of rt.projectiles) {
            if (p.kind !== "singularity") continue;
            const tp = rt.worldOf(p.s, p.d, 0);
            ctx.beginPath();
            ctx.arc(W / 2 + (tp.x - mapFit.x) * mapFit.k, H / 2 + (tp.z - mapFit.z) * mapFit.k, 6, 0, Math.PI * 2);
            ctx.fillStyle = "#000";
            ctx.fill();
            ctx.strokeStyle = "#b18cff";
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.dispose();
      rt.detach();
    };
  }, [rt, reduced, isTouch]);

  useEffect(() => lockGestures(stageRef.current), []);

  // Keyboard.
  useEffect(() => {
    const set = (e: KeyboardEvent, down: boolean) => {
      const k = keys.current;
      let used = true;
      switch (e.code) {
        case "ArrowLeft":
        case "KeyA":
          k.left = down;
          break;
        case "ArrowRight":
        case "KeyD":
          k.right = down;
          break;
        case "ArrowUp":
        case "KeyW":
          k.up = down;
          break;
        case "ArrowDown":
        case "KeyS":
          k.down = down;
          break;
        case "Space":
        case "ShiftLeft":
        case "ShiftRight":
        case "KeyK":
          k.drift = down;
          break;
        case "KeyC":
        case "KeyQ":
          k.back = down;
          break;
        case "KeyE":
        case "KeyX":
        case "KeyL":
        case "Enter":
          if (down && !e.repeat) {
            rt.fire();
            if (rt.phase === "results") rt.continueResults();
            if (rt.phase === "intro") rt.skipIntro();
          }
          break;
        default:
          used = false;
      }
      if (used) {
        e.preventDefault();
        if (down) rt.audio.resume();
      }
    };
    const down = (e: KeyboardEvent) => set(e, true);
    const up = (e: KeyboardEvent) => set(e, false);
    const blur = () => Object.assign(keys.current, { left: false, right: false, up: false, down: false, drift: false, back: false });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [rt]);

  /* Touch controls ------------------------------------------------- */

  const onSteerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    rt.audio.resume();
    const t = touch.current;
    if (t.steerId !== null) return;
    t.steerId = e.pointerId;
    t.steerX0 = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSteerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (t.steerId !== e.pointerId) return;
    const dx = e.clientX - t.steerX0;
    t.steer = Math.max(-1, Math.min(1, dx / 55));
    setSteerKnob(t.steer);
  };
  const onSteerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (t.steerId !== e.pointerId) return;
    t.steerId = null;
    t.steer = 0;
    setSteerKnob(0);
  };

  const onStageDown = () => {
    rt.audio.resume();
    if (rt.phase === "intro") rt.skipIntro();
    if (rt.phase === "results") rt.continueResults();
  };

  const me = rt.me;
  return (
    <div ref={stageRef} className="absolute inset-0 touch-none overflow-hidden bg-black" onPointerDown={onStageDown}>
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <div ref={flashRef} className="pointer-events-none absolute inset-0 bg-[#b56bff] opacity-0 mix-blend-screen" />
      {webglError ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/80">This race needs WebGL. Try another browser or device.</div>
      ) : null}
      <div className="pointer-events-none absolute inset-0">
        {rt.racers
          .filter((r) => r !== me)
          .map((r) => (
            <div
              key={r.idx}
              ref={(el) => {
                if (el) tagRefs.current.set(r.idx, el);
                else tagRefs.current.delete(r.idx);
              }}
              className="absolute left-0 top-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold text-white opacity-0"
              style={{ background: "rgba(10,6,30,0.65)", border: `1.5px solid ${r.livery.glow}` }}
            >
              {r.name}
            </div>
          ))}
      </div>
      <RaceHud hud={hud} onExit={onExit} onRetry={onRetry} minimap={<canvas ref={miniRef} width={150} height={150} className="size-[118px] sm:size-[150px]" />} />
      {isTouch && !hud.spectator && (hud.phase === "race" || hud.phase === "countdown") ? (
        <TouchControls
          knob={steerKnob}
          onSteerDown={onSteerDown}
          onSteerMove={onSteerMove}
          onSteerUp={onSteerUp}
          onDrift={(on) => (touch.current.drift = on)}
          onBrake={(on) => (touch.current.brake = on)}
          onFire={() => rt.fire()}
          onWake={() => rt.audio.resume()}
        />
      ) : null}
      {!isTouch && hud.phase === "intro" && hud.raceIndex === 0 ? (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 text-[11px] font-semibold text-white/85">
          ↑/W thrust · ←→ steer · Space drift & tricks · E item (hold ↓ to fire back) · C look back
        </div>
      ) : null}
    </div>
  );
}

function TouchControls(props: {
  knob: number;
  onSteerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSteerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSteerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDrift: (on: boolean) => void;
  onBrake: (on: boolean) => void;
  onFire: () => void;
  onWake: () => void;
}) {
  const btn = "grid select-none place-items-center rounded-full border-[3px] border-white/85 font-black italic text-white shadow-[0_4px_0_rgba(0,0,0,0.45)] active:scale-95";
  return (
    <>
      <div
        className="absolute bottom-0 left-0 h-[46%] w-[48%] touch-none"
        onPointerDown={(e) => {
          e.stopPropagation();
          props.onSteerDown(e);
        }}
        onPointerMove={props.onSteerMove}
        onPointerUp={props.onSteerUp}
        onPointerCancel={props.onSteerUp}
      >
        <div className="absolute bottom-6 left-1/2 h-14 w-44 -translate-x-1/2 rounded-full border-2 border-white/40 bg-black/25">
          <div
            className="absolute top-1/2 size-16 -translate-y-1/2 rounded-full border-[3px] border-white bg-white/25 backdrop-blur"
            style={{ left: `calc(50% - 32px + ${props.knob * 60}px)` }}
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lg text-white/70">◀</span>
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-lg text-white/70">▶</span>
        </div>
      </div>
      <div className="absolute bottom-5 right-4 flex items-end gap-3">
        <div
          className={`${btn} size-14 bg-[rgba(255,70,70,0.55)] text-xs`}
          onPointerDown={(e) => {
            e.stopPropagation();
            props.onWake();
            props.onBrake(true);
          }}
          onPointerUp={() => props.onBrake(false)}
          onPointerCancel={() => props.onBrake(false)}
          onPointerLeave={() => props.onBrake(false)}
        >
          BRAKE
        </div>
        <div className="flex flex-col items-center gap-3">
          <div
            className={`${btn} size-16 bg-[rgba(120,80,255,0.6)] text-sm`}
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onWake();
              props.onFire();
            }}
          >
            ITEM
          </div>
          <div
            className={`${btn} size-20 bg-[rgba(255,150,40,0.6)] text-base`}
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onWake();
              props.onDrift(true);
            }}
            onPointerUp={() => props.onDrift(false)}
            onPointerCancel={() => props.onDrift(false)}
            onPointerLeave={() => props.onDrift(false)}
          >
            DRIFT
          </div>
        </div>
      </div>
    </>
  );
}
