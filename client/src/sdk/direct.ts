/**
 * Direct connections: a WebRTC data-channel mesh between the match's players.
 *
 * The XApps room only carries the signaling (offer, answer, ICE candidates:
 * a handful of messages per pair of players), under the reserved event type
 * `xapps.direct`. Game traffic then flows browser to browser, which is faster
 * and never counts against the room's message quota. When a peer can't be
 * reached directly (still connecting, or ICE failed behind a strict NAT with
 * no TURN server) `send` falls back to the room for that peer, throttled for
 * fast messages, and receivers get both paths through the same `onMessage`.
 *
 * Client-side only: no host method is involved, so any XApps host (and the
 * mock host) works. Purpose `match` only; spectators can't send, so they get
 * no connections, but can receive relayed copies (`spectators: true`).
 */

import { XAppsError, type Json } from "./protocol";

type Unsubscribe = () => void;
type Timer = ReturnType<typeof setTimeout>;

/**
 * `connecting`: negotiating (messages go over the room meanwhile) · `direct`:
 * both data channels are open · `relay`: no direct path for now (ICE failed or
 * timed out, or WebRTC is unavailable); messages go over the room while it
 * retries in the background · `closed`: not here (left, or the mesh closed).
 */
export type DirectStatus = "connecting" | "direct" | "relay" | "closed";
export type DirectVia = "direct" | "relay";

export interface DirectOptions {
  /** ICE servers. Default: public STUN (Google, Cloudflare). Add a TURN server for strict NATs. */
  iceServers?: RTCIceServer[];
  /** Max fast (unreliable) messages per second over the room fallback, all relayed peers at once. Default 10; 0 never relays them. */
  relayHz?: number;
  /** Also relay every message to online spectators (they can't open connections). Default false. */
  spectators?: boolean;
  /** Give up on a connection attempt after this long and use the room (retrying later). Default 12 s. */
  connectTimeoutMs?: number;
  /** Round-trip ping over the reliable channel (also a liveness check). Default 2 s. */
  pingMs?: number;
  /** Fast messages are dropped while a channel has more than this many bytes queued. Default 64 KB. */
  maxBufferedBytes?: number;
  /** Stand-in for `RTCPeerConnection` (tests, polyfills). `null` disables WebRTC: everything relays. */
  rtc?: (new (config: RTCConfiguration) => RTCPeerConnection) | null;
}

export interface DirectSendOptions {
  /** Ordered and retransmitted (the `reliable` channel). Default: the `fast` channel (unordered, no retransmits). */
  reliable?: boolean;
  /** Just this player. Default: every connected player (and spectators with `spectators: true`). */
  to?: string;
}

export interface DirectPeerInfo {
  id: string;
  status: DirectStatus;
  /** Round trip over the direct path in ms, when it's up. */
  rtt: number | null;
}

export interface DirectMesh {
  /** This mesh's session id (changes when the page reloads). */
  readonly session: string;
  /** Send to every player (or `to`), directly where possible, over the room otherwise. Never throws. */
  send(data: Json, options?: DirectSendOptions): void;
  /** Messages from other players, whichever path they took (deduplicated). */
  onMessage(handler: (data: Json, from: string, via: DirectVia) => void): Unsubscribe;
  status(peerId: string): DirectStatus;
  rtt(peerId: string): number | null;
  peers(): DirectPeerInfo[];
  onStatus(handler: (peerId: string, status: DirectStatus) => void): Unsubscribe;
  /** Closes every connection and stops listening. */
  close(): void;
}

/** The parts of the client a mesh uses (an `XAppsClient` fits). */
export interface DirectClient {
  readonly purpose: string;
  readonly isSpectator: boolean;
  readonly me: { readonly id: string };
  readonly players: readonly { readonly id: string; readonly isBot: boolean }[];
  readonly room: {
    send(type: string, payload: Json): Promise<unknown>;
    on(type: string, handler: (payload: Json, from: string) => void): Unsubscribe;
    onPresence(handler: (online: string[]) => void): Unsubscribe;
    online(): string[];
  };
}

/** Room event type the mesh uses for signaling and relayed messages. */
export const DIRECT_EVENT = "xapps.direct";
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

const RESEND_MS = 2500;
/** The answerer waits this long before asking for an offer (one is often already on its way). */
const HELLO_DELAY_MS = 400;
const MAX_RESENDS = 3;
const ICE_BATCH_MS = 100;
const ICE_BATCH_MAX = 16;
const DISCONNECT_GRACE_MS = 4000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30_000;
const SEEN_WINDOW = 512;
/** A player we heard from this recently counts as here, whatever presence says (it lags). */
const HEARD_MS = 10_000;

type Signal =
  | { k: "hello"; to: string; s: string }
  | { k: "offer"; to: string; s: string; g: number; sdp: string }
  | { k: "answer"; to: string; s: string; r: string; g: number; sdp: string }
  | { k: "ice"; to: string; s: string; g: number; c: RTCIceCandidateInit[] }
  | { k: "bye"; to: string[]; s: string }
  | { k: "m"; to: string[]; s: string; n: number; d: Json; r?: 1 };

interface Peer {
  id: string;
  /** We make the offers (the lower player id does, so both sides agree). */
  initiator: boolean;
  status: DirectStatus;
  present: boolean;
  /** Said goodbye (closed its mesh): not talked to until it signals again. */
  left: boolean;
  heardAt: number;
  pc: RTCPeerConnection | null;
  fast: RTCDataChannel | null;
  reliable: RTCDataChannel | null;
  /** Negotiation generation: the initiator counts up, the answerer adopts. */
  gen: number;
  remoteSid: string | null;
  offeredAt: number;
  resends: number;
  failures: number;
  inIce: { s: string; g: number; c: RTCIceCandidateInit }[];
  outIce: RTCIceCandidateInit[];
  iceTimer: Timer | null;
  resendTimer: Timer | null;
  connectTimer: Timer | null;
  retryTimer: Timer | null;
  graceTimer: Timer | null;
  rtt: number | null;
  rxAt: number;
  awaitingSince: number;
  seenSid: string | null;
  seenMax: number;
  seen: Set<number>;
}

const randomSid = () => Math.random().toString(36).slice(2, 10);
const ignore = () => {};

function isSignal(v: unknown): v is Signal {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as { k?: unknown; s?: unknown };
  return typeof m.k === "string" && typeof m.s === "string";
}

function addressedTo(to: unknown, id: string): boolean {
  return to === id || (Array.isArray(to) && to.includes(id));
}

/**
 * Opens direct connections to the other players of the match (see `DirectMesh`).
 * One mesh per page: close it when the match view goes away.
 */
export function createDirectMesh(client: DirectClient, options: DirectOptions = {}): DirectMesh {
  if (client.purpose !== "match") throw new XAppsError("forbidden", "room.direct: there is no match room here");
  return new Mesh(client, options);
}

class Mesh implements DirectMesh {
  readonly session = randomSid();
  private readonly me: string;
  private readonly peersById = new Map<string, Peer>();
  private readonly messageHandlers = new Set<(data: Json, from: string, via: DirectVia) => void>();
  private readonly statusHandlers = new Set<(peerId: string, status: DirectStatus) => void>();
  private readonly offs: Unsubscribe[] = [];
  private readonly rtc: (new (config: RTCConfiguration) => RTCPeerConnection) | null;
  private readonly iceServers: RTCIceServer[];
  private readonly relayHz: number;
  private readonly connectTimeoutMs: number;
  private readonly pingMs: number;
  private readonly maxBuffered: number;
  private readonly canSend: boolean;
  private online: Set<string> | null = null;
  private seq = 0;
  private lastFastRelay = -Infinity;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly client: DirectClient,
    private readonly options: DirectOptions,
  ) {
    this.me = client.me.id;
    this.canSend = !client.isSpectator;
    const native = typeof RTCPeerConnection === "function" ? RTCPeerConnection : null;
    this.rtc = options.rtc === undefined ? native : options.rtc;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.relayHz = Math.max(0, options.relayHz ?? 10);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 12_000;
    this.pingMs = Math.max(250, options.pingMs ?? 2000);
    this.maxBuffered = options.maxBufferedBytes ?? 64 * 1024;

    this.offs.push(client.room.on(DIRECT_EVENT, (payload, from) => this.onRoom(payload, from)));
    if (this.canSend) {
      for (const p of client.players) {
        if (p.isBot || p.id === this.me) continue;
        this.peersById.set(p.id, this.newPeer(p.id));
      }
      this.offs.push(client.room.onPresence((ids) => this.onPresence(ids)));
      const known = client.room.online();
      // Before the host tells us who's here, assume everyone seated is.
      this.onPresence(known.length ? known : null);
      this.pingTimer = setInterval(() => this.tick(), this.pingMs);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  send(data: Json, options: DirectSendOptions = {}): void {
    if (this.closed || !this.canSend) return;
    const reliable = !!options.reliable;
    const n = ++this.seq;
    let frame: string | null = null;
    const relayTo: string[] = [];
    const now = Date.now();

    const targets: Peer[] = [];
    if (options.to !== undefined) {
      const peer = this.peersById.get(options.to);
      if (peer) targets.push(peer);
      else if (this.options.spectators && this.isSpectatorId(options.to)) relayTo.push(options.to);
    } else {
      for (const peer of this.peersById.values()) targets.push(peer);
      if (this.options.spectators) relayTo.push(...this.spectatorIds());
    }

    for (const peer of targets) {
      if (!this.here(peer, now)) continue;
      const ch = reliable ? peer.reliable : peer.fast;
      if (peer.status === "direct" && ch && ch.readyState === "open") {
        // Stale state is worth less than fresh state: drop rather than queue.
        if (!reliable && ch.bufferedAmount > this.maxBuffered) continue;
        try {
          ch.send((frame ??= JSON.stringify({ n, d: data })));
          continue;
        } catch {
          // closing: use the room this time
        }
      }
      relayTo.push(peer.id);
    }

    if (!relayTo.length) return;
    if (!reliable) {
      if (this.relayHz <= 0 || now - this.lastFastRelay < 1000 / this.relayHz) return;
      this.lastFastRelay = now;
    }
    const msg: Signal = { k: "m", to: relayTo, s: this.session, n, d: data };
    if (reliable) msg.r = 1;
    this.client.room.send(DIRECT_EVENT, msg as unknown as Json).catch(ignore);
  }

  onMessage(handler: (data: Json, from: string, via: DirectVia) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (peerId: string, status: DirectStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  status(peerId: string): DirectStatus {
    return this.peersById.get(peerId)?.status ?? "closed";
  }

  rtt(peerId: string): number | null {
    const peer = this.peersById.get(peerId);
    return peer?.status === "direct" ? peer.rtt : null;
  }

  peers(): DirectPeerInfo[] {
    return [...this.peersById.values()].map((p) => ({ id: p.id, status: p.status, rtt: p.status === "direct" ? p.rtt : null }));
  }

  close(): void {
    if (this.closed) return;
    const connected = [...this.peersById.values()].filter((p) => p.pc).map((p) => p.id);
    if (connected.length) this.signal({ k: "bye", to: connected, s: this.session });
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.offs.forEach((off) => off());
    for (const peer of this.peersById.values()) {
      this.teardown(peer);
      this.clearTimer(peer, "retryTimer");
      this.setStatus(peer, "closed");
    }
    this.messageHandlers.clear();
    this.statusHandlers.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Presence                                                           */
  /* ------------------------------------------------------------------ */

  private newPeer(id: string): Peer {
    return {
      id,
      initiator: this.me < id,
      status: "closed",
      present: false,
      left: false,
      heardAt: 0,
      pc: null,
      fast: null,
      reliable: null,
      gen: 0,
      remoteSid: null,
      offeredAt: 0,
      resends: 0,
      failures: 0,
      inIce: [],
      outIce: [],
      iceTimer: null,
      resendTimer: null,
      connectTimer: null,
      retryTimer: null,
      graceTimer: null,
      rtt: null,
      rxAt: 0,
      awaitingSince: 0,
      seenSid: null,
      seenMax: 0,
      seen: new Set(),
    };
  }

  /** Is this seated human (not us) someone we talk to? */
  private seatedHuman(id: string): boolean {
    return id !== this.me && this.client.players.some((p) => p.id === id && !p.isBot);
  }

  private isSpectatorId(id: string): boolean {
    return id !== this.me && !this.client.players.some((p) => p.id === id);
  }

  private spectatorIds(): string[] {
    return this.online ? [...this.online].filter((id) => this.isSpectatorId(id)) : [];
  }

  private here(peer: Peer, now: number): boolean {
    if (peer.status === "direct") return true;
    return !peer.left && (peer.present || now - peer.heardAt < HEARD_MS);
  }

  private peerFor(id: string): Peer | null {
    let peer = this.peersById.get(id);
    if (!peer && this.canSend && this.seatedHuman(id)) {
      peer = this.newPeer(id);
      this.peersById.set(id, peer);
    }
    return peer ?? null;
  }

  private onPresence(ids: string[] | null): void {
    if (this.closed) return;
    this.online = ids ? new Set(ids) : null;
    for (const id of ids ?? []) if (this.seatedHuman(id)) this.peerFor(id);
    for (const peer of this.peersById.values()) {
      const present = !this.online || this.online.has(peer.id);
      peer.present = present;
      if (present && peer.status === "closed" && !peer.left) this.begin(peer);
      // Gone: a live connection tells us itself when it drops, anything else stops now.
      else if (!present && peer.status !== "direct" && peer.status !== "closed" && Date.now() - peer.heardAt >= HEARD_MS) this.drop(peer);
    }
  }

  private begin(peer: Peer): void {
    peer.failures = 0;
    if (!this.rtc) {
      this.setStatus(peer, "relay");
      return;
    }
    this.setStatus(peer, "connecting");
    if (peer.initiator) void this.offer(peer);
    else this.hello(peer);
  }

  private drop(peer: Peer): void {
    this.teardown(peer);
    this.clearTimer(peer, "retryTimer");
    this.setStatus(peer, "closed");
  }

  /* ------------------------------------------------------------------ */
  /* Negotiation                                                        */
  /* ------------------------------------------------------------------ */

  private hello(peer: Peer): void {
    this.setTimer(peer, "resendTimer", HELLO_DELAY_MS, () => {
      if (!peer.pc) this.signal({ k: "hello", to: peer.id, s: this.session });
    });
    // If no offer comes, fall back and ask again later.
    this.setTimer(peer, "connectTimer", this.connectTimeoutMs, () => this.fail(peer));
  }

  private async offer(peer: Peer): Promise<void> {
    if (!this.rtc) return;
    this.teardown(peer);
    if (peer.status === "direct") this.setStatus(peer, "relay");
    const gen = ++peer.gen;
    const pc = this.makePc(peer);
    this.wire(peer, pc, pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 }));
    this.wire(peer, pc, pc.createDataChannel("reliable", { ordered: true }));
    peer.offeredAt = Date.now();
    peer.resends = 0;
    this.setTimer(peer, "connectTimer", this.connectTimeoutMs, () => this.fail(peer));
    try {
      await pc.setLocalDescription(await pc.createOffer());
    } catch {
      if (peer.pc === pc) this.fail(peer);
      return;
    }
    if (peer.pc !== pc || this.closed) return;
    this.sendOffer(peer, pc, gen);
  }

  private sendOffer(peer: Peer, pc: RTCPeerConnection, gen: number): void {
    const sdp = pc.localDescription?.sdp;
    if (!sdp) return;
    this.signal({ k: "offer", to: peer.id, s: this.session, g: gen, sdp });
    // The room can drop messages: offer again until answered (the SDP by then holds our candidates too).
    this.setTimer(peer, "resendTimer", RESEND_MS, () => {
      if (peer.pc !== pc || pc.remoteDescription || peer.resends >= MAX_RESENDS) return;
      peer.resends++;
      this.sendOffer(peer, pc, gen);
    });
  }

  private async onOffer(peer: Peer, m: Extract<Signal, { k: "offer" }>): Promise<void> {
    if (peer.initiator || typeof m.sdp !== "string" || typeof m.g !== "number") return;
    if (m.s === peer.remoteSid && m.g === peer.gen && peer.pc) {
      // A resent offer: our answer may have been lost.
      const sdp = peer.pc.localDescription?.sdp;
      if (sdp && peer.status !== "direct") this.signal({ k: "answer", to: peer.id, s: this.session, r: m.s, g: m.g, sdp });
      return;
    }
    if (m.s === peer.remoteSid && m.g < peer.gen) return; // stale
    if (!this.rtc) return;
    this.teardown(peer);
    this.clearTimer(peer, "retryTimer");
    if (peer.status === "closed") this.setStatus(peer, "connecting");
    else if (peer.status === "direct") this.setStatus(peer, "relay");
    peer.remoteSid = m.s;
    peer.gen = m.g;
    const pc = this.makePc(peer);
    this.setTimer(peer, "connectTimer", this.connectTimeoutMs, () => this.fail(peer));
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      if (peer.pc !== pc) return;
      await this.applyIce(peer, pc);
      await pc.setLocalDescription(await pc.createAnswer());
    } catch {
      if (peer.pc === pc) this.fail(peer);
      return;
    }
    const sdp = pc.localDescription?.sdp;
    if (peer.pc !== pc || this.closed || !sdp) return;
    this.signal({ k: "answer", to: peer.id, s: this.session, r: m.s, g: m.g, sdp });
  }

  private async onAnswer(peer: Peer, m: Extract<Signal, { k: "answer" }>): Promise<void> {
    const pc = peer.pc;
    if (!peer.initiator || !pc || m.r !== this.session || m.g !== peer.gen || typeof m.sdp !== "string") return;
    if (pc.signalingState !== "have-local-offer") return;
    peer.remoteSid = m.s;
    this.clearTimer(peer, "resendTimer");
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      if (peer.pc === pc) await this.applyIce(peer, pc);
    } catch {
      if (peer.pc === pc) this.fail(peer);
    }
  }

  private onIce(peer: Peer, m: Extract<Signal, { k: "ice" }>): void {
    if (!Array.isArray(m.c) || typeof m.g !== "number") return;
    if (m.s === peer.remoteSid && m.g < peer.gen) return; // an old negotiation
    // Candidates can overtake the offer or answer in the room: keep them until it's applied.
    for (const c of m.c.slice(0, 32)) if (c && typeof c === "object") peer.inIce.push({ s: m.s, g: m.g, c });
    if (peer.inIce.length > 64) peer.inIce.splice(0, peer.inIce.length - 64);
    const pc = peer.pc;
    if (pc && pc.remoteDescription) void this.applyIce(peer, pc);
  }

  private async applyIce(peer: Peer, pc: RTCPeerConnection): Promise<void> {
    const current = (x: { s: string; g: number }) => x.s === peer.remoteSid && x.g === peer.gen;
    const mine = peer.inIce.filter(current);
    peer.inIce = peer.inIce.filter((x) => !current(x) && !(x.s === peer.remoteSid && x.g < peer.gen));
    for (const { c } of mine) {
      if (peer.pc !== pc) return;
      await pc.addIceCandidate(c).catch(ignore);
    }
  }

  private onHello(peer: Peer, m: Extract<Signal, { k: "hello" }>): void {
    if (!peer.initiator) return;
    const restarted = peer.remoteSid !== null && m.s !== peer.remoteSid;
    const pc = peer.pc;
    if (pc && !restarted && !pc.remoteDescription && Date.now() - peer.offeredAt < this.connectTimeoutMs) {
      // Our offer is still out there: say it again now rather than starting over.
      this.sendOffer(peer, pc, peer.gen);
      return;
    }
    if (peer.status === "closed") this.setStatus(peer, "connecting");
    peer.failures = 0;
    this.clearTimer(peer, "retryTimer");
    void this.offer(peer);
  }

  /* ------------------------------------------------------------------ */
  /* Connections                                                        */
  /* ------------------------------------------------------------------ */

  private makePc(peer: Peer): RTCPeerConnection {
    const Rtc = this.rtc!;
    const pc = new Rtc({ iceServers: this.iceServers });
    peer.pc = pc;
    pc.onicecandidate = (e) => {
      if (peer.pc !== pc) return;
      if (e.candidate) {
        peer.outIce.push(e.candidate.toJSON());
        if (peer.outIce.length >= ICE_BATCH_MAX) this.flushIce(peer);
        else if (!peer.iceTimer) peer.iceTimer = setTimeout(() => this.flushIce(peer), ICE_BATCH_MS);
      } else this.flushIce(peer);
    };
    pc.oniceconnectionstatechange = () => {
      if (peer.pc !== pc) return;
      const state = pc.iceConnectionState;
      if (state === "failed") this.fail(peer);
      else if (state === "disconnected") {
        // Often recovers by itself (a Wi-Fi hiccup); rebuild if it doesn't.
        this.setTimer(peer, "graceTimer", DISCONNECT_GRACE_MS, () => {
          if (peer.pc === pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") this.fail(peer);
        });
      } else if (state === "connected" || state === "completed") this.clearTimer(peer, "graceTimer");
    };
    pc.ondatachannel = (e) => this.wire(peer, pc, e.channel);
    return pc;
  }

  private flushIce(peer: Peer): void {
    this.clearTimer(peer, "iceTimer");
    if (!peer.outIce.length || !peer.pc) return;
    const c = peer.outIce.splice(0, ICE_BATCH_MAX);
    this.signal({ k: "ice", to: peer.id, s: this.session, g: peer.gen, c });
    if (peer.outIce.length) peer.iceTimer = setTimeout(() => this.flushIce(peer), ICE_BATCH_MS);
  }

  private wire(peer: Peer, pc: RTCPeerConnection, ch: RTCDataChannel): void {
    if (ch.label === "fast") peer.fast = ch;
    else if (ch.label === "reliable") peer.reliable = ch;
    else return;
    ch.onopen = () => this.opened(peer, pc);
    ch.onclose = () => {
      if (peer.pc === pc) this.fail(peer);
    };
    ch.onmessage = (e: MessageEvent) => {
      if (peer.pc !== pc) return;
      this.onFrame(peer, e.data);
    };
    // Channels announced by the other side can arrive already open.
    if (ch.readyState === "open") queueMicrotask(() => this.opened(peer, pc));
  }

  private opened(peer: Peer, pc: RTCPeerConnection): void {
    if (peer.pc !== pc || peer.status === "direct" || peer.fast?.readyState !== "open" || peer.reliable?.readyState !== "open") return;
    this.clearTimer(peer, "connectTimer");
    this.clearTimer(peer, "resendTimer");
    this.clearTimer(peer, "retryTimer");
    peer.failures = 0;
    peer.rxAt = Date.now();
    peer.awaitingSince = 0;
    peer.heardAt = Date.now();
    this.setStatus(peer, "direct");
    this.ping(peer);
  }

  private onFrame(peer: Peer, raw: unknown): void {
    if (typeof raw !== "string") return;
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const now = Date.now();
    peer.rxAt = now;
    peer.heardAt = now;
    peer.awaitingSince = 0;
    const f = m as { n?: unknown; d?: Json; ping?: unknown; pong?: unknown };
    if (typeof f.ping === "number") {
      try {
        peer.reliable?.send(JSON.stringify({ pong: f.ping }));
      } catch {
        // closing
      }
      return;
    }
    if (typeof f.pong === "number") {
      const rtt = Math.max(0, now - f.pong);
      peer.rtt = peer.rtt === null ? rtt : Math.round(peer.rtt * 0.7 + rtt * 0.3);
      return;
    }
    if (typeof f.n === "number" && f.d !== undefined) this.deliver(peer, peer.remoteSid ?? "", f.n, f.d, "direct");
  }

  /** Lost the direct path (or never got one): relay for now, try again with backoff. */
  private fail(peer: Peer): void {
    if (this.closed) return;
    this.teardown(peer);
    if (peer.status === "closed") return;
    this.setStatus(peer, "relay");
    if (!this.rtc) return;
    // The initiator retries first; the other side only asks again if nothing came.
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** peer.failures) + (peer.initiator ? 0 : 3000);
    peer.failures++;
    this.setTimer(peer, "retryTimer", delay, () => {
      if (peer.status !== "relay" || peer.pc) return;
      if (!this.here(peer, Date.now())) {
        this.setStatus(peer, "closed");
        return;
      }
      if (peer.initiator) void this.offer(peer);
      else this.hello(peer);
    });
  }

  private teardown(peer: Peer): void {
    const pc = peer.pc;
    peer.pc = null;
    for (const ch of [peer.fast, peer.reliable]) {
      if (!ch) continue;
      ch.onopen = ch.onclose = ch.onmessage = null;
      try {
        ch.close();
      } catch {
        // already closed
      }
    }
    peer.fast = peer.reliable = null;
    peer.outIce = [];
    peer.rtt = null;
    peer.awaitingSince = 0;
    for (const t of ["iceTimer", "resendTimer", "connectTimer", "graceTimer"] as const) this.clearTimer(peer, t);
    if (pc) {
      pc.onicecandidate = pc.oniceconnectionstatechange = pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
  }

  /** Pings direct peers, and treats one that stopped answering as lost. */
  private tick(): void {
    const now = Date.now();
    for (const peer of this.peersById.values()) {
      if (peer.status !== "direct") continue;
      // Closed under us without an event (closing the connection locally fires none).
      if (peer.fast?.readyState !== "open" || peer.reliable?.readyState !== "open") {
        this.fail(peer);
        continue;
      }
      if (peer.awaitingSince && now - peer.awaitingSince > Math.max(3 * this.pingMs, 6000)) {
        this.fail(peer);
        continue;
      }
      this.ping(peer);
    }
  }

  private ping(peer: Peer): void {
    const ch = peer.reliable;
    if (!ch || ch.readyState !== "open") return;
    try {
      ch.send(JSON.stringify({ ping: Date.now() }));
      if (!peer.awaitingSince) peer.awaitingSince = Date.now();
    } catch {
      // closing
    }
  }

  /* ------------------------------------------------------------------ */
  /* Room                                                               */
  /* ------------------------------------------------------------------ */

  private signal(m: Signal): void {
    if (!this.canSend || this.closed) return;
    this.client.room.send(DIRECT_EVENT, m as unknown as Json).catch(ignore);
  }

  private onRoom(payload: Json, from: string): void {
    const m: unknown = payload;
    if (this.closed || from === this.me || !isSignal(m)) return;
    if (!addressedTo(m.to, this.me)) return;
    if (m.k === "m") {
      if (typeof m.n !== "number" || m.d === undefined || !this.client.players.some((p) => p.id === from && !p.isBot)) return;
      const peer = this.peersById.get(from);
      if (peer) {
        peer.heardAt = Date.now();
        if (peer.left && m.s !== peer.remoteSid) peer.left = false;
      }
      this.deliver(peer ?? null, m.s, m.n, m.d, "relay", from);
      return;
    }
    const peer = this.peerFor(from);
    if (!peer) return;
    peer.heardAt = Date.now();
    if (m.k !== "bye") peer.left = false;
    switch (m.k) {
      case "hello":
        this.onHello(peer, m);
        break;
      case "offer":
        void this.onOffer(peer, m);
        break;
      case "answer":
        void this.onAnswer(peer, m);
        break;
      case "ice":
        this.onIce(peer, m);
        break;
      case "bye":
        if (m.s !== peer.remoteSid) break;
        this.teardown(peer);
        this.clearTimer(peer, "retryTimer");
        peer.left = true;
        this.setStatus(peer, "closed");
        break;
    }
  }

  /** Hands a message to the app once, whichever path it came by. */
  private deliver(peer: Peer | null, sid: string, n: number, data: Json, via: DirectVia, fromId?: string): void {
    const from = peer?.id ?? fromId;
    if (!from) return;
    if (peer) {
      if (peer.seenSid !== sid) {
        peer.seenSid = sid;
        peer.seenMax = 0;
        peer.seen.clear();
      }
      if (n <= peer.seenMax - SEEN_WINDOW || peer.seen.has(n)) return;
      peer.seen.add(n);
      if (n > peer.seenMax) peer.seenMax = n;
      if (peer.seen.size > SEEN_WINDOW * 2) for (const x of peer.seen) if (x <= peer.seenMax - SEEN_WINDOW) peer.seen.delete(x);
    }
    for (const handler of Array.from(this.messageHandlers)) {
      try {
        handler(data, from, via);
      } catch (error) {
        console.error("[xapps] direct message handler threw", error);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private setStatus(peer: Peer, status: DirectStatus): void {
    if (peer.status === status) return;
    peer.status = status;
    for (const handler of Array.from(this.statusHandlers)) {
      try {
        handler(peer.id, status);
      } catch (error) {
        console.error("[xapps] direct status handler threw", error);
      }
    }
  }

  private setTimer(peer: Peer, key: "iceTimer" | "resendTimer" | "connectTimer" | "retryTimer" | "graceTimer", ms: number, fn: () => void): void {
    this.clearTimer(peer, key);
    peer[key] = setTimeout(() => {
      peer[key] = null;
      if (!this.closed) fn();
    }, ms);
  }

  private clearTimer(peer: Peer, key: "iceTimer" | "resendTimer" | "connectTimer" | "retryTimer" | "graceTimer"): void {
    const t = peer[key];
    if (t) clearTimeout(t);
    peer[key] = null;
  }
}
