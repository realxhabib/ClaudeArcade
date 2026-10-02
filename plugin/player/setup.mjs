#!/usr/bin/env node
// Finds a browser to run the game in, or downloads Chrome's headless shell
// once. Lives here rather than in the mod so Windows paths, environment
// variables and the download work the same everywhere with plain Node.
//
//   node setup.mjs find              {"platform":"win64","browser":"C:\\...\\msedge.exe"|null}
//   node setup.mjs download <dir>    {"platform":...,"browser":"<dir>/chrome-headless-shell-.../..."}
//
// Either prints {"error":"..."} (exit 1) on trouble. The platform is Chrome for
// Testing's name for it ("mac-arm64", "mac-x64", "linux64", "win64"), or null.

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSIONS = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

export function platformName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (platform === "linux" && arch === "x64") return "linux64";
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "win64";
  return null;
}

/** Installed browsers that can run the game headless, in the order they're tried. */
export function systemBrowsers(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    // Edge comes with Windows, so nearly everyone has a browser already.
    return [
      ...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

export function downloadedBrowser(dir, platform) {
  const exe = platform === "win64" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  return join(dir, `chrome-headless-shell-${platform}`, exe);
}

async function download(dir, platform) {
  const binary = downloadedBrowser(dir, platform);
  if (existsSync(binary)) return binary;
  const versions = await (await fetch(VERSIONS)).json();
  const url = versions.channels.Stable.downloads["chrome-headless-shell"].find((d) => d.platform === platform)?.url;
  if (!url) throw new Error(`no headless Chrome for ${platform}`);
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, "chrome.zip");
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  // Windows 10 and later ship bsdtar, which reads zips; macOS and Linux have unzip.
  const unpack = platform === "win64" ? spawnSync("tar", ["-xf", zip, "-C", dir]) : spawnSync("unzip", ["-q", "-o", zip, "-d", dir]);
  rmSync(zip, { force: true });
  if (unpack.status !== 0) throw new Error(`unpacking failed: ${String(unpack.stderr ?? unpack.error ?? "").trim()}`);
  if (!existsSync(binary)) throw new Error("the download didn't contain the browser");
  return binary;
}

async function main() {
  const [command, dir] = process.argv.slice(2);
  const platform = platformName();
  if (command === "find") {
    const browser = systemBrowsers().find((path) => existsSync(path)) ?? (dir && platform && existsSync(downloadedBrowser(dir, platform)) ? downloadedBrowser(dir, platform) : null);
    return { platform, browser };
  }
  if (command === "download" && dir) {
    if (!platform) throw new Error(`no headless Chrome for ${process.platform} ${process.arch}`);
    return { platform, browser: await download(dir, platform) };
  }
  throw new Error("usage: setup.mjs find [dir] | download <dir>");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("setup.mjs")) {
  main().then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      process.stdout.write(JSON.stringify({ error: error.message }) + "\n");
      process.exit(1);
    },
  );
}
