/**
 * Player input: keyboard + mouse with pointer lock on desktop, and the
 * on-screen twin-stick controls on phones, merged into one Intent and a
 * look delta per frame.
 *
 * Desktop: WASD / arrows move, Shift sprints, C or Ctrl crouches (hold),
 * Space jumps, left mouse fires, right mouse aims, R reloads, 1/2 or the
 * wheel (or Q) swaps, G (hold to aim, release to throw) throws a grenade,
 * Tab holds the scoreboard, Esc releases the mouse.
 */

import type { Intent } from "./game";

export interface TouchState {
  /** Left stick −1…1 (x right, y forward). */
  mx: number;
  my: number;
  /** Look drag accumulated since the last frame (px). */
  lookX: number;
  lookY: number;
  fire: boolean;
  ads: boolean;
  crouch: boolean;
  jump: boolean;
  reload: boolean;
  swap: boolean;
  /** Grenade button held (throws on release). */
  grenade: boolean;
}

const GAME_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "KeyC",
  "ControlLeft",
  "KeyR",
  "Digit1",
  "Digit2",
  "KeyQ",
  "KeyG",
  "Tab",
  "Digit3",
  "Digit4",
]);

/** Arrow-key turning in Claude Arcade, radians per second (yaw, pitch). */
const ARROW_TURN = 2.6;
const ARROW_PITCH = 1.5;

/** Claude Arcade: always "locked", look from cursor movement (see `attach`). */
let arcadeMode = false;
export function setArcadeMode(on: boolean): void {
  arcadeMode = on;
}

export class Input {
  private readonly keys = new Set<string>();
  private mouseFire = false;
  private mouseAds = false;
  private lookX = 0;
  private lookY = 0;
  private jumpEdge = false;
  private reloadEdge = false;
  private slotEdge = -1;
  private swapEdge = false;
  private detach: (() => void) | null = null;
  private target: HTMLElement | null = null;
  readonly touch: TouchState = { mx: 0, my: 0, lookX: 0, lookY: 0, fire: false, ads: false, crouch: false, jump: false, reload: false, swap: false, grenade: false };
  locked = false;
  private sampledAt = performance.now();
  /** Pressed anything yet (hides hints). */
  used = false;
  scoreboard = false;
  private lockListeners = new Set<(locked: boolean) => void>();
  private scoreListeners = new Set<(on: boolean) => void>();
  private digitListeners = new Set<(n: number) => void>();

  attach(target: HTMLElement): void {
    if (this.detach) return;
    this.target = target;
    // Claude Arcade: the game runs headless and is played through a terminal pane, which has no
    // pointer lock. The mouse is always "locked": look comes from how far the cursor moved.
    let lastX: number | null = null;
    let lastY: number | null = null;
    if (arcadeMode) {
      // The Claude Arcade player turns the view by pixels of mouse movement (from the terminal pane).
      (window as unknown as { __arcadeLook?: (dx: number, dy: number) => void }).__arcadeLook = (dx, dy) => {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.lookX += Math.max(-400, Math.min(400, dx));
        this.lookY += Math.max(-400, Math.min(400, dy));
        this.used = true;
      };
      this.locked = true;
      queueMicrotask(() => this.lockListeners.forEach((l) => l(true)));
    }
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (!GAME_KEYS.has(e.code) || typing(e)) return;
      if (e.code === "Tab") {
        e.preventDefault();
        if (!this.scoreboard) {
          this.scoreboard = true;
          this.scoreListeners.forEach((l) => l(true));
        }
        return;
      }
      e.preventDefault();
      if (!e.repeat) {
        if (e.code.startsWith("Digit")) this.digitListeners.forEach((l) => l(Number(e.code.slice(5))));
        if (e.code === "Space") this.jumpEdge = true;
        if (e.code === "KeyR") this.reloadEdge = true;
        if (e.code === "Digit1") this.slotEdge = 0;
        if (e.code === "Digit2") this.slotEdge = 1;
        if (e.code === "KeyQ") this.swapEdge = true;
      }
      this.keys.add(e.code);
      this.used = true;
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === "Tab" && this.scoreboard) {
        this.scoreboard = false;
        this.scoreListeners.forEach((l) => l(false));
      }
    };
    const blur = () => {
      this.keys.clear();
      this.mouseFire = false;
      this.mouseAds = false;
    };
    const move = (e: MouseEvent) => {
      if (arcadeMode && !document.pointerLockElement) {
        const dx = lastX === null ? 0 : e.clientX - lastX;
        const dy = lastY === null ? 0 : e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
        this.lookX += dx;
        this.lookY += dy;
        return;
      }
      if (!this.locked) return;
      // Some browsers report a huge jump on the first event after locking.
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    };
    const mdown = (e: MouseEvent) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseAds = true;
      this.used = true;
    };
    const mup = (e: MouseEvent) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseAds = false;
    };
    const wheel = (e: WheelEvent) => {
      if (!this.locked) return;
      if (Math.abs(e.deltaY) > 4) this.swapEdge = true;
    };
    const menu = (e: Event) => e.preventDefault();
    const lockChange = () => {
      if (arcadeMode) return;
      const locked = document.pointerLockElement === this.target;
      if (locked === this.locked) return;
      this.locked = locked;
      if (!locked) {
        this.mouseFire = false;
        this.mouseAds = false;
      }
      this.lockListeners.forEach((l) => l(locked));
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("mousemove", move);
    document.addEventListener("mousedown", mdown);
    document.addEventListener("mouseup", mup);
    document.addEventListener("wheel", wheel, { passive: true });
    target.addEventListener("contextmenu", menu);
    document.addEventListener("pointerlockchange", lockChange);
    this.detach = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mousedown", mdown);
      document.removeEventListener("mouseup", mup);
      document.removeEventListener("wheel", wheel);
      target.removeEventListener("contextmenu", menu);
      document.removeEventListener("pointerlockchange", lockChange);
    };
  }

  /** Must run inside a click (browsers only grant pointer lock on a user gesture). */
  requestLock(): void {
    if (arcadeMode) return;
    const t = this.target;
    if (!t || this.locked) return;
    try {
      const p = t.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // Not allowed here (e.g. the frame lacks allow-pointer-lock): the game stays playable with the overlay.
    }
  }

  releaseLock(): void {
    if (arcadeMode) return;
    if (this.locked && document.pointerLockElement) document.exitPointerLock();
  }

  onLock(fn: (locked: boolean) => void): () => void {
    this.lockListeners.add(fn);
    return () => this.lockListeners.delete(fn);
  }

  /** Number keys 1–4 (the death screen uses them to pick the next primary). */
  onDigit(fn: (n: number) => void): () => void {
    this.digitListeners.add(fn);
    return () => this.digitListeners.delete(fn);
  }

  onScoreboard(fn: (on: boolean) => void): () => void {
    this.scoreListeners.add(fn);
    return () => this.scoreListeners.delete(fn);
  }

  /**
   * The intent for this frame and the look delta in radians. `sens` is the
   * settings number; `zoom` scales look speed while aiming (tan ratio of FOVs).
   */
  sample(intent: Intent, sens: number, invert: boolean, zoom: number, currentSlot: number): { dYaw: number; dPitch: number } {
    const k = this.keys;
    const t = this.touch;
    // Claude Arcade: arrows turn and look (a terminal can't lend the game the mouse), WASD moves.
    const arrows = !arcadeMode;
    const fwd = (k.has("KeyW") || (arrows && k.has("ArrowUp")) ? 1 : 0) - (k.has("KeyS") || (arrows && k.has("ArrowDown")) ? 1 : 0);
    const side = (k.has("KeyD") || (arrows && k.has("ArrowRight")) ? 1 : 0) - (k.has("KeyA") || (arrows && k.has("ArrowLeft")) ? 1 : 0);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.sampledAt) / 1000));
    this.sampledAt = now;
    let keyYaw = 0;
    let keyPitch = 0;
    if (arcadeMode) {
      keyYaw = ((k.has("ArrowLeft") ? 1 : 0) - (k.has("ArrowRight") ? 1 : 0)) * ARROW_TURN * dt * zoom;
      keyPitch = ((k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0)) * ARROW_PITCH * dt * zoom;
    }
    const stick = Math.hypot(t.mx, t.my);
    intent.forward = Math.max(-1, Math.min(1, fwd + t.my));
    intent.strafe = Math.max(-1, Math.min(1, side + t.mx));
    // Touch sprint: stick pushed to the edge, mostly forward.
    intent.sprint = k.has("ShiftLeft") || k.has("ShiftRight") || (stick > 0.93 && t.my > 0.75);
    intent.crouch = k.has("KeyC") || k.has("ControlLeft") || t.crouch;
    intent.jump = this.jumpEdge || t.jump;
    intent.fire = this.mouseFire || t.fire;
    intent.ads = this.mouseAds || t.ads;
    intent.reload = this.reloadEdge || t.reload;
    intent.grenade = k.has("KeyG") || t.grenade;
    const swap = this.swapEdge || t.swap;
    intent.slot = this.slotEdge >= 0 ? this.slotEdge : swap ? 1 - currentSlot : -1;
    this.jumpEdge = false;
    this.reloadEdge = false;
    this.slotEdge = -1;
    this.swapEdge = false;
    t.jump = false;
    t.reload = false;
    t.swap = false;
    const mouse = sens * 0.001 * zoom;
    const touch = sens * 0.0024 * zoom;
    const dYaw = -(this.lookX * mouse + t.lookX * touch) + keyYaw;
    const dPitch = (-(this.lookY * mouse + t.lookY * touch) + keyPitch) * (invert ? -1 : 1);
    this.lookX = 0;
    this.lookY = 0;
    t.lookX = 0;
    t.lookY = 0;
    return { dYaw, dPitch };
  }

  /** On-screen controls write here (buttons, stick). */
  setTouch(patch: Partial<TouchState>): void {
    Object.assign(this.touch, patch);
    this.used = true;
  }

  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  /** One shot from a release (the sniper's quick-scope): fire for a few frames, then apply `after`. */
  pulseFire(after: Partial<TouchState> = {}, ms = 90): void {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.setTouch({ fire: true });
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null;
      this.setTouch({ fire: false, ...after });
    }, ms);
  }

  private readonly drags = new Map<number, { x: number; y: number }>();

  /** A finger started dragging to look (look pad, or the fire button). */
  lookStart(id: number, x: number, y: number): void {
    this.drags.set(id, { x, y });
  }

  lookMove(id: number, x: number, y: number): void {
    const last = this.drags.get(id);
    if (!last) return;
    this.touch.lookX += x - last.x;
    this.touch.lookY += y - last.y;
    last.x = x;
    last.y = y;
  }

  lookEnd(id: number): void {
    this.drags.delete(id);
  }

  /** Drops held buttons (menus opening, death). */
  release(): void {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = null;
    this.drags.clear();
    this.mouseFire = false;
    this.mouseAds = false;
    this.keys.clear();
    const t = this.touch;
    t.fire = false;
    t.grenade = false;
    t.mx = 0;
    t.my = 0;
    t.lookX = 0;
    t.lookY = 0;
  }

  dispose(): void {
    this.releaseLock();
    this.detach?.();
    this.detach = null;
    this.lockListeners.clear();
    this.scoreListeners.clear();
    this.digitListeners.clear();
  }
}

export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? "ontouchstart" in window;
}
