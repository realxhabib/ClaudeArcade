#!/usr/bin/env node
// Claude Arcade player: the arcade's equivalent of intermission's patched Doom
// engine. Runs the real game in headless Chrome or Edge (driven over a pipe, no
// npm dependencies), hands each frame to the pane, and turns the pane's keys
// and mouse into the game's input. Three ways to show the game:
//   pixels  a PNG file the terminal paints itself (Ghostty, kitty)
//   cells   "▀" block characters, two pixels per cell, for any terminal with
//           true colour (Windows Terminal, iTerm2, VS Code's)
//   window  not headless: the game in its own browser window, played there
//           with the real keyboard and mouse; the pane only shows the score
//
//   node player.mjs --chrome <path> --url <game url>
//                   [--view pixels|cells|window] [--columns 160] [--frames <dir>]
//                   [--width 640] [--height 360] [--fps 30] [--sound]
//
// stdout, one JSON line each: {"input":"http://127.0.0.1:<port>/<token>"}
//   first, {"ready":true} once the page loaded, per frame
//   {"frame":"<path>","gen":n} or {"cells":"<base64>","columns","rows","gen"},
//   {"hud":{...}} when the game's numbers change (src/frontline/status.ts),
//   {"error":"..."} on trouble.
// Input: HTTP on localhost, behind the printed URL's random token:
//   POST <url>/input { keys: string[] (KeyboardEvent.code held), fire, aim:
//     boolean, look: { dx, dy } (pixels of mouse movement since the last post) }
//   POST <url>/view { view: "pixels" | "cells", columns } switches on the fly
//     (headless only; a window stays a window).
//   POST <url>/window { state: "normal" | "minimized" } shows or hides the window. Minimized, it
//     also leaves the game (a hidden page stops running, and other players would wait on it if it
//     ran their bots); shown again, it rejoins where it was (the same game, not the menu).
//   POST <url>/notice { text } shows a line over the game ("" clears it).
// Killing this process (or its parent going away) ends Chrome too (its pipe closes).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, toCells } from "./cells.mjs";
import { raiseWindow } from "./raise.mjs";

const args = parseArgs(process.argv.slice(2));
const WIDTH = Number(args.width ?? 640);
const HEIGHT = Number(args.height ?? 360);
const FRAME_MS = 1000 / Number(args.fps ?? 30);
if (!args.chrome || !args.url) {
  out({ error: "usage: player.mjs --chrome <path> --url <url> [--view pixels|cells] [--columns n]" });
  process.exit(2);
}
const frames = args.frames ? String(args.frames) : join(tmpdir(), `claudearcade-${process.pid}`);
mkdirSync(frames, { recursive: true });
const WINDOWED = args.view === "window";
let view = args.view === "cells" ? "cells" : "pixels";
let columns = clampColumns(args.columns ?? 160);
const profile = join(tmpdir(), `claudearcade-profile-${process.pid}`);

const chromeArgs = [
  ...(WINDOWED ? [] : ["--headless"]),
  "--remote-debugging-pipe",
  WINDOWED ? "--window-size=1280,760" : `--window-size=${WIDTH},${HEIGHT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--autoplay-policy=no-user-gesture-required",
  "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization",
  ...(process.platform === "darwin" ? ["--use-angle=metal"] : ["--enable-unsafe-swiftshader"]),
  ...(args.sound ? [] : ["--mute-audio"]),
  // Chrome refuses to run as root without it (containers, CI); a person's own session never is root.
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
  ...(args["extra-chrome-args"] ? String(args["extra-chrome-args"]).split(" ").filter(Boolean) : []),
  // A window with no tabs or address bar, just the game.
  WINDOWED ? `--app=${args.url}` : "about:blank",
];
const chrome = spawn(args.chrome, chromeArgs, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let chromeLog = "";
chrome.on("exit", (code) => {
  out({ error: `chrome exited (${code}): ${chromeLog.trim().split("\n").slice(-3).join(" | ")}` });
  cleanup();
  process.exit(1);
});
chrome.stderr.on("data", (d) => (chromeLog = (chromeLog + d).slice(-4000)));
chrome.on("error", (error) => {
  out({ error: `chrome failed to start: ${error.message}` });
  process.exit(1);
});
process.on("SIGTERM", shutdown);
// The mod ending its loop kills us; if the whole session died instead, notice we were orphaned
// (reparented on macOS and Linux; on Windows the parent's pid just stops answering).
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent || !isAlive(parent)) shutdown();
}, 2000).unref();
process.on("SIGINT", shutdown);

/* ---------------------------------------------------------------- CDP over the pipe */

const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
// Chrome going away resets the pipes: its exit handler reports it.
toChrome.on("error", () => {});
fromChrome.on("error", () => {});
let nextId = 1;
const pending = new Map();
const listeners = new Map();
let buffered = "";
fromChrome.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let end;
  while ((end = buffered.indexOf("\0")) >= 0) {
    const raw = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      listeners.get(msg.method)?.(msg.params, msg.sessionId);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/* ---------------------------------------------------------------- the page */

let session = null;
let target = null;
let gen = 0;

async function start() {
  const { targetInfos } = await cdp("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const targetId = page ? page.targetId : (await cdp("Target.createTarget", { url: "about:blank" })).targetId;
  target = targetId;
  ({ sessionId: session } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable", {}, session);
  if (!WINDOWED) await cdp("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, session);
  if (!WINDOWED) listeners.set("Page.loadEventFired", () => out({ ready: true }));
  // The person closing the game window ends the game.
  listeners.set("Target.detachedFromTarget", () => shutdown());
  void hudLoop();
  // The app window opened on the game already.
  if (WINDOWED) {
    out({ ready: true });
    // The window opens behind whatever has focus on Windows: lift it once it exists (and again in
    // case the first try came before it did).
    void raiseWindow(chrome.pid).then((n) => (n ? undefined : sleep(1500).then(() => raiseWindow(chrome.pid))));
    return;
  }
  await cdp("Page.navigate", { url: args.url }, session);
  void captureLoop();
  // Keep the page "focused" so it gets keys and keeps rendering.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, session).catch(() => {});
}

/** Where the window was before it was put away, to rejoin there. */
let awayFrom = null;

/** Shows (and brings to the front) or minimizes the game window, leaving the game while it's away. */
async function setWindow(state) {
  if (!WINDOWED || !target) return;
  const { windowId } = await cdp("Browser.getWindowForTarget", { targetId: target });
  if (state === "minimized") {
    if (awayFrom === null) {
      const { result } = await cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }, session);
      awayFrom = typeof result?.value === "string" && result.value.startsWith("http") ? result.value : args.url;
      await cdp("Page.navigate", { url: "about:blank" }, session);
    }
    await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    return;
  }
  await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  if (awayFrom !== null) {
    const url = awayFrom;
    awayFrom = null;
    await cdp("Page.navigate", { url }, session);
  }
  await cdp("Page.bringToFront", {}, session);
  // Chrome's bringToFront can't get past Windows' foreground lock from the background.
  await raiseWindow(chrome.pid);
}

async function notice(text) {
  if (!session) return;
  await cdp("Runtime.evaluate", { expression: `window.__arcadeNotice && window.__arcadeNotice(${JSON.stringify(String(text ?? "").slice(0, 120))})` }, session);
}

/**
 * One exact-size PNG of the page per frame (the screencast resizes frames unpredictably in headless
 * mode). For cells the page is captured scaled down to one pixel per column.
 */
async function captureLoop() {
  let lastCells = "";
  while (!stopped) {
    const began = Date.now();
    try {
      const cells = view === "cells";
      const scale = cells ? columns / WIDTH : 1;
      const clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale };
      const { data } = await cdp("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false, optimizeForSpeed: true }, session);
      const png = Buffer.from(data, "base64");
      if (cells) {
        const grid = toCells(decodePng(png));
        // A still picture (the death screen, a pause) needn't cross the pipe again.
        if (grid.cells !== lastCells) {
          lastCells = grid.cells;
          gen += 1;
          out({ ...grid, gen });
        }
      } else {
        lastCells = "";
        // Two files, alternating: the terminal reads one while the next is written.
        const path = join(frames, `frame-${gen % 2}.png`);
        writeFileSync(path, png);
        gen += 1;
        out({ frame: path, gen });
      }
    } catch (error) {
      out({ error: `capture: ${error.message}` });
      await sleep(500);
    }
    await sleep(Math.max(0, FRAME_MS - (Date.now() - began)));
  }
}

/** The game's numbers for the pane's status line, sent when they change. */
async function hudLoop() {
  let last = "";
  while (!stopped) {
    try {
      const { result } = await cdp("Runtime.evaluate", { expression: "JSON.stringify(window.__arcadeHud ? window.__arcadeHud() : null)", returnByValue: true }, session);
      const text = typeof result?.value === "string" ? result.value : "null";
      if (text !== last) {
        last = text;
        out({ hud: JSON.parse(text) });
      }
    } catch {
      // the page is between loads
    }
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

start().catch((error) => {
  out({ error: `chrome: ${error.message}` });
  shutdown();
});

/* ---------------------------------------------------------------- input */

const KEYS = {
  KeyW: ["w", 87], KeyA: ["a", 65], KeyS: ["s", 83], KeyD: ["d", 68],
  KeyR: ["r", 82], KeyG: ["g", 71], KeyC: ["c", 67], KeyQ: ["q", 81], KeyE: ["e", 69], KeyF: ["f", 70],
  Space: [" ", 32], ShiftLeft: ["Shift", 16], ControlLeft: ["Control", 17], Tab: ["Tab", 9], Escape: ["Escape", 27],
  Digit1: ["1", 49], Digit2: ["2", 50], Digit3: ["3", 51], Digit4: ["4", 52],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Enter: ["Enter", 13],
};
const held = new Set();
let fire = false;
let aim = false;

async function applyInput(input) {
  if (!session) return;
  const want = new Set((Array.isArray(input.keys) ? input.keys : []).filter((k) => KEYS[k]));
  for (const code of held) if (!want.has(code)) await key("keyUp", code);
  for (const code of want) if (!held.has(code)) await key("keyDown", code);
  if (!!input.fire !== fire) await button("left", (fire = !!input.fire));
  if (!!input.aim !== aim) await button("right", (aim = !!input.aim));
  const dx = Number(input.look?.dx ?? 0);
  const dy = Number(input.look?.dy ?? 0);
  if (dx || dy) await cdp("Runtime.evaluate", { expression: `window.__arcadeLook && window.__arcadeLook(${dx}, ${dy})` }, session);
}

async function key(type, code) {
  const [k, vk] = KEYS[code];
  if (type === "keyDown") held.add(code);
  else held.delete(code);
  await cdp("Input.dispatchKeyEvent", { type, code, key: k, windowsVirtualKeyCode: vk, text: type === "keyDown" && k.length === 1 ? k : undefined }, session);
}

async function button(which, down) {
  await cdp(
    "Input.dispatchMouseEvent",
    { type: down ? "mousePressed" : "mouseReleased", x: WIDTH / 2, y: HEIGHT / 2, button: which, clickCount: 1, buttons: down ? (which === "left" ? 1 : 2) : 0 },
    session,
  );
}

// Localhost TCP (a unix socket isn't a thing on Windows); the random token keeps other local
// programs and web pages from typing into the game.
const token = randomBytes(16).toString("hex");
const server = createServer((req, res) => {
  const route = req.method === "POST" && req.url?.startsWith(`/${token}/`) ? req.url.slice(token.length + 2) : null;
  if (route !== "input" && route !== "view" && route !== "window" && route !== "notice") {
    res.statusCode = 404;
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body = (body + c).slice(0, 16_384)));
  req.on("end", () => {
    let msg = null;
    try {
      msg = JSON.parse(body);
    } catch {
      // ignore a bad post
    }
    if (route === "window" || route === "notice") {
      (route === "window" ? setWindow(msg?.state) : notice(msg?.text)).then(
        () => res.end("{}"),
        (error) => res.end(JSON.stringify({ error: error.message })),
      );
      return;
    }
    if (route === "view") {
      if (!WINDOWED && (msg?.view === "cells" || msg?.view === "pixels")) view = msg.view;
      if (msg?.columns !== undefined) columns = clampColumns(msg.columns);
      res.end("{}");
      return;
    }
    applyInput(msg ?? {}).then(
      () => res.end("{}"),
      (error) => res.end(JSON.stringify({ error: error.message })),
    );
  });
});
server.listen(0, "127.0.0.1", () => out({ input: `http://127.0.0.1:${server.address().port}/${token}` }));

/* ---------------------------------------------------------------- plumbing */

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Cells are one pixel wide; the Raster takes up to 512 columns (and 256 rows: 455 columns at 16:9). */
function clampColumns(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(16, Math.min(Math.floor((256 * 2 * WIDTH) / HEIGHT), 512, n)) : 160;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 2) {
      result[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) result[name] = true;
    else {
      result[name] = next;
      i++;
    }
  }
  return result;
}

let stopped = false;
function cleanup() {
  try {
    server.close();
    rmSync(frames, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
function shutdown() {
  if (stopped) return;
  stopped = true;
  chrome.removeAllListeners("exit");
  chrome.kill("SIGTERM");
  cleanup();
  process.exit(0);
}
