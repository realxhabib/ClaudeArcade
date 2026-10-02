#!/usr/bin/env node
// Claude Arcade player: the arcade's equivalent of intermission's patched Doom
// engine. Runs the real game in headless Chrome (driven over a pipe, no npm
// dependencies), writes each frame as a PNG the terminal paints into the
// pane, and turns the pane's keys and mouse into the game's input.
//
//   node player.mjs --chrome <path> --url <game url> --frames <dir> --socket <path>
//                   [--width 640] [--height 360] [--fps 30] [--sound]
//
// stdout, one JSON line each: {"ready":true} once the page loaded,
//   {"frame":"<path>","gen":<n>} per frame, {"error":"..."} on trouble.
// Input: HTTP on the unix socket, POST /input with
//   { keys: string[] (KeyboardEvent.code held), fire, aim: boolean,
//     look: { dx, dy } (pixels of mouse movement since the last post) }.
// Killing this process (or its parent going away) ends Chrome too (its pipe closes).

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const WIDTH = Number(args.width ?? 640);
const HEIGHT = Number(args.height ?? 360);
const FRAME_MS = 1000 / Number(args.fps ?? 30);
if (!args.chrome || !args.url || !args.frames || !args.socket) {
  out({ error: "usage: player.mjs --chrome <path> --url <url> --frames <dir> --socket <path>" });
  process.exit(2);
}
mkdirSync(args.frames, { recursive: true });
const profile = join(tmpdir(), `claudearcade-profile-${process.pid}`);

const chromeArgs = [
  "--headless",
  "--remote-debugging-pipe",
  `--window-size=${WIDTH},${HEIGHT}`,
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
  "about:blank",
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
// The mod ending its loop kills us; if the whole session died instead, notice we were orphaned.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) shutdown();
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
let gen = 0;

async function start() {
  const { targetInfos } = await cdp("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const targetId = page ? page.targetId : (await cdp("Target.createTarget", { url: "about:blank" })).targetId;
  ({ sessionId: session } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable", {}, session);
  await cdp("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, session);
  listeners.set("Page.loadEventFired", () => out({ ready: true }));
  await cdp("Page.navigate", { url: args.url }, session);
  void captureLoop();
  // Keep the page "focused" so it gets keys and keeps rendering.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, session).catch(() => {});
}

/** One exact-size PNG of the page per frame (the screencast resizes frames unpredictably in headless mode). */
async function captureLoop() {
  const clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 };
  while (!stopped) {
    const began = Date.now();
    try {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false, optimizeForSpeed: true }, session);
      // Two files, alternating: the terminal reads one while the next is written.
      const path = join(args.frames, `frame-${gen % 2}.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      gen += 1;
      out({ frame: path, gen });
    } catch (error) {
      out({ error: `capture: ${error.message}` });
      await sleep(500);
    }
    await sleep(Math.max(0, FRAME_MS - (Date.now() - began)));
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

rmSync(args.socket, { force: true });
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/input") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let input = null;
      try {
        input = JSON.parse(body);
      } catch {
        // ignore a bad post
      }
      applyInput(input ?? {}).then(
        () => res.end("{}"),
        (error) => res.end(JSON.stringify({ error: error.message })),
      );
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(args.socket);

/* ---------------------------------------------------------------- plumbing */

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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
    rmSync(args.socket, { force: true });
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
