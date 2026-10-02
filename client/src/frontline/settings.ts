/**
 * Player settings (look sensitivity, invert, aim assist, quality) and the
 * last loadout, saved with the SDK's per-player storage so they follow the
 * player across devices, mirrored in localStorage so the first frame
 * already uses them.
 */

import type { XAppsClient } from "@xapps/sdk";
import type { QualityPref } from "./quality";
import { DEFAULT_LOADOUT, parseLoadout, type Loadout } from "./weapons";

export interface Settings {
  /** Mouse: radians per pixel × 1000. Touch uses its own scale of the same number. */
  sensitivity: number;
  invert: boolean;
  aimAssist: boolean;
  quality: QualityPref;
  loadout: Loadout;
}

export const DEFAULT_SETTINGS: Settings = { sensitivity: 2.2, invert: false, aimAssist: true, quality: "auto", loadout: DEFAULT_LOADOUT };

const KEY = "settings";
const LOCAL = "frontline:settings";

export function parseSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const sens = typeof o.sensitivity === "number" && Number.isFinite(o.sensitivity) ? Math.min(8, Math.max(0.3, o.sensitivity)) : DEFAULT_SETTINGS.sensitivity;
  const quality = o.quality === "high" || o.quality === "medium" || o.quality === "low" || o.quality === "auto" ? o.quality : "auto";
  return {
    sensitivity: sens,
    invert: o.invert === true,
    aimAssist: o.aimAssist !== false,
    quality,
    loadout: parseLoadout(o.loadout),
  };
}

export function loadLocal(): Settings {
  try {
    const url = new URLSearchParams(window.location.search).get("quality");
    const raw = window.localStorage.getItem(LOCAL);
    const s = parseSettings(raw ? JSON.parse(raw) : null);
    if (url === "high" || url === "medium" || url === "low") s.quality = url;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Reads the synced copy (it wins over the local one when it exists). */
export async function loadRemote(xapps: XAppsClient): Promise<Settings | null> {
  try {
    const raw = await xapps.storage.get(KEY);
    return raw ? parseSettings(raw) : null;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Saves locally now and to SDK storage shortly after (debounced; spectators can't write). */
export function saveSettings(xapps: XAppsClient, s: Settings): void {
  try {
    window.localStorage.setItem(LOCAL, JSON.stringify(s));
  } catch {
    // storage blocked
  }
  if (xapps.isSpectator || xapps.purpose === "setup") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    xapps.storage.set(KEY, { ...s, loadout: { ...s.loadout } }).catch((error: unknown) => console.warn("[frontline] saving settings failed", error));
  }, 600);
}
