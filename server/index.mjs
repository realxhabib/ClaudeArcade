// The arcade server: serves the Frontline client and runs the always-on lobby
// on the same port (WebSocket at /lobby?name=...). Usage: node index.mjs
// PORT (default 8787) and CLIENT_DIR (default ../client/dist) from the env.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Lobby } from "./lobby.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const CLIENT_DIR = resolve(process.env.CLIENT_DIR ?? join(here, "../client/dist"));
const MAX_MESSAGE_BYTES = 128 * 1024;
const MESSAGES_PER_SECOND = 120;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".hdr": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

const lobby = new Lobby();
setInterval(() => lobby.tick(), 1000);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, round: lobby.round, online: lobby.online().length }));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(CLIENT_DIR, path);
  if (!file.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(CLIENT_DIR, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("Build the client first: npm run build in client/");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, { "content-type": type, "cache-control": cache });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/lobby") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => accept(ws, url.searchParams.get("name")));
});

function accept(ws, name) {
  let budget = MESSAGES_PER_SECOND;
  const refill = setInterval(() => (budget = MESSAGES_PER_SECOND), 1000);
  const conn = {
    seat: null,
    name: null,
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  conn.send(lobby.join(conn, name));
  ws.on("message", (data) => {
    if (--budget < 0) return; // a client gone wrong can't flood the lobby
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const reply = lobby.handle(conn, msg);
    if (reply) conn.send(reply);
  });
  ws.on("close", () => {
    clearInterval(refill);
    lobby.leave(conn);
  });
}

server.listen(PORT, () => console.log(`claudearcade: http://localhost:${PORT} (client ${CLIENT_DIR})`));
