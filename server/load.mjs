// Load test: `node load.mjs <players> [url]` connects that many simulated players to a running
// arcade server and has each send a move packet 11 times a second (the rate a real player's game
// relays through the server when peer-to-peer can't connect), padded to a real packet's size.
import WebSocket from "ws";

const players = Number(process.argv[2] ?? 8);
const url = process.argv[3] ?? "ws://127.0.0.1:8787/lobby";
const payload = { s: 3, d: "x".repeat(180) };
let received = 0;
for (let i = 0; i < players; i++) {
  const ws = new WebSocket(`${url}?name=Load${i}`);
  ws.on("message", () => received++);
  ws.on("open", () => setInterval(() => ws.send(JSON.stringify({ t: "room", type: "fl.p", payload })), 1000 / 11));
  ws.on("error", () => {});
}
setInterval(() => {
  console.log(JSON.stringify({ players, receivedPerSecond: received }));
  received = 0;
}, 1000);
