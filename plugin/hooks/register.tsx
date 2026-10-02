// Claude Arcade: drops you into a game while Claude works (Frontline, the
// shooter, or Nova Rally, the kart racer: a menu picks the first time, and
// `/arcade game` switches), on a shared server with everyone else waiting on
// Claude, and hands you back when it's done (or at once when Claude needs you). The intermission pattern: an
// always-on game server (../../server), and here the real game running
// headless (../player/player.mjs, Chrome or Edge) painting its frames into a pane.
//
// Three views: "pixels", real images in the pane, where the terminal draws them
// (Ghostty, kitty); "blocks", the picture in "▀" characters, two pixels per
// cell, in any true-colour terminal; and "window", the game in its own browser
// window that pops up while Claude works and minimizes when it's done, the pane
// keeping the score. Windows, and the Claude desktop app (no terminal), start
// in a window; elsewhere a terminal that turns out not to draw images switches
// to blocks by itself. `/arcade view` picks one.

import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const PANE = 'claudearcade'
const TITLE = 'Claude Arcade'
/** Kept in step with .claude-plugin/plugin.json; `/arcade` says it, so an update is easy to check. */
const VERSION = '0.4.3'
/**
 * The arcade server everyone waiting on Claude joins: set it here once yours is deployed (see the
 * README's Hosting section). `/arcade server <url>` overrides it per person.
 */
const DEFAULT_SERVER = 'http://174.138.34.59:8787'
const WIDTH = 640
const HEIGHT = 360
const DROP_IN_DELAY_MS = 2000
const COUNTDOWN_SECONDS = 3
/** After a hand-back the game keeps its seat this long, so the next turn drops straight back in. */
const KEEP_WARM_MS = 90_000
/** Image blits refused in a row before the pane decides this terminal can't draw images. */
const DENIES_BEFORE_BLOCKS = 4
/** The widest block picture (the Raster's 256-row limit at 16:9) and the narrowest worth drawing. */
const MAX_BLOCK_COLUMNS = 455
const MIN_BLOCK_COLUMNS = 40

const NAME_STARTS = ['Idle', 'Queued', 'Pending', 'Async', 'Blocked', 'Waiting', 'Bored']
const NAME_ENDS = ['Soldier', 'Sniper', 'Grunt', 'Medic', 'Recruit', 'Dev']

type Timer = { cancel: () => void }
type Stream = AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> & { return?: () => unknown }
type View = 'pixels' | 'blocks' | 'window'
type Grid = { cells: string; columns: number; rows: number; gen: number }

type Game = 'frontline' | 'rally'
const GAME_NAMES: Record<Game, string> = { frontline: 'Frontline', rally: 'Nova Rally' }
const CONTROLS: Record<Game | 'menu', { pane: string; window: string }> = {
  menu: { pane: 'Press 1 for Frontline or 2 for Nova Rally', window: 'Pick a game in the window' },
  frontline: {
    pane: 'Click the game · WASD moves · mouse or arrows aim · left click fires · right click aims down sights · Shift sprints · Space jumps · R reloads · G grenade',
    window: 'Click the game to aim with the mouse · Esc frees the mouse · WASD moves · left click fires',
  },
  rally: {
    pane: 'Click the game · W or ↑ thrust · A D or ← → steer · Space drifts · E fires your item · C looks back',
    window: 'W or ↑ thrust · A D or ← → steer · Space drifts · E fires your item · C looks back',
  },
}

/**
 * What the game reports for the status line: Frontline's numbers (client/src/frontline/status.ts),
 * or a ready-made `text` (Nova Rally, the menu), and which `game` is on (null on the menu).
 */
export type Hud = {
  game?: Game | null
  text?: string
  alive: boolean
  hp: number
  weapon: string
  mag: number
  reserve: number
  reloading: boolean
  respawnIn: number
  killedBy: string | null
  kills: number
  deaths: number
  best: { name: string; kills: number } | null
  people: number
}

let isOn = false
let name = 'QueuedSoldier'
let server = DEFAULT_SERVER
/** The game picked last (the menu skips to it); null shows the menu. */
let game: Game | null = null
/** What the person picked with `/arcade view`; `auto` is a window on Windows or without a terminal, else pixels until refused. */
let viewChoice: 'auto' | View = 'auto'
let view: View = 'pixels'
/** Node's `process.platform` where the game runs, once asked. */
let platform: string | null = null
/** Whether the running player is a game window (switching to or from one restarts it). */
let playerWindowed = false

//   idle      not playing
//   waiting   Claude is working; dropping in once the delay passes
//   playing   the pane is open and the game runs
//   countdown Claude is done; closing when the count reaches zero
let phase: 'idle' | 'waiting' | 'playing' | 'countdown' = 'idle'
let isTurnRunning = false
let isDismissed = false
let timer: Timer | null = null
let countdown = 0

// The running player: its output stream, the newest frame (a PNG file or block cells), its input URL.
let player: Stream | null = null
let frame: { file: string; gen: number } | null = null
let grid: Grid | null = null
let hud: Hud | null = null
let inputUrl: string | null = null
/** The block picture's size as last drawn: a frame of another size needs a redraw, not a blit. */
let drawn: { columns: number; rows: number } | null = null
/** The block width the pane has room for, last told to the player. */
let blockColumns = 160
let imageDenies = 0
let warmTimer: Timer | null = null
let status: string | null = null
let setupWork: Promise<string | null> | null = null

function randomName() {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!
  return pick(NAME_STARTS) + pick(NAME_ENDS) + Math.floor(Math.random() * 90 + 10)
}

function cancelTimer() {
  timer?.cancel()
  timer = null
}

function armDropIn($: Engine) {
  if (!isOn || !isTurnRunning || isDismissed || phase !== 'idle') return
  phase = 'waiting'
  timer = $.clock.after(DROP_IN_DELAY_MS, () => void dropIn($))
}

/** Settles `view` for this drop-in: the person's pick, or what suits this machine and app. */
async function resolveView($: Engine): Promise<View | null> {
  const hasTerminal = (await $.session.surfaces()).includes('terminal')
  if (viewChoice !== 'auto') return viewChoice === 'window' || hasTerminal ? viewChoice : null
  if (platform === null) {
    const run = await $.process.run(['node', '-p', 'process.platform']).catch(() => null)
    platform = run?.exitCode === 0 ? run.stdout.trim() : ''
  }
  // Windows terminals can't draw images in Claude Code (blocks are too coarse to play well), and
  // the desktop app has no terminal at all: a real game window plays best.
  if (platform === 'win32' || !hasTerminal) return 'window'
  return view === 'blocks' ? 'blocks' : 'pixels'
}

async function dropIn($: Engine) {
  if (phase !== 'waiting') return
  timer = null
  const next = await resolveView($)
  if (!next || phase !== 'waiting') {
    if (phase === 'waiting') phase = 'idle'
    return
  }
  adoptView(next)
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  if (!opened.isPlaced) {
    await $.ui.close({ id: PANE })
    phase = 'idle'
    return
  }
  await startPlaying($)
}

/** Takes `next` as the view; a running player of the other kind (window or headless) goes. */
function adoptView(next: View) {
  if (next === view) return
  view = next
  if (player && playerWindowed !== (next === 'window')) stopPlayer()
  clearFrames()
}

async function startPlaying($: Engine) {
  phase = 'playing'
  warmTimer?.cancel()
  warmTimer = null
  $.ui.invalidate('ui.render')
  if (!player) void runPlayer($)
  else if (playerWindowed) {
    await postToPlayer($, 'notice', { text: '' })
    await postToPlayer($, 'window', { state: 'normal' })
  }
}

function startCountdown($: Engine) {
  cancelTimer()
  phase = 'countdown'
  countdown = COUNTDOWN_SECONDS
  $.ui.invalidate('ui.render')
  const say = () => playerWindowed && void postToPlayer($, 'notice', { text: `Claude's done · back to Claude in ${countdown}` })
  say()
  timer = $.clock.every(1000, () => {
    countdown--
    if (countdown > 0) {
      say()
      $.ui.invalidate('ui.render')
    } else void handBack($)
  })
}

async function handBack($: Engine) {
  cancelTimer()
  if (phase === 'idle') return
  phase = 'idle'
  await $.ui.close({ id: PANE })
  await putAway($)
}

/** Out of the way between turns, seat kept warm: keys let go, the window minimized. */
async function putAway($: Engine) {
  await sendInput($, { keys: [], fire: false, aim: false })
  if (playerWindowed) {
    await postToPlayer($, 'notice', { text: '' })
    await postToPlayer($, 'window', { state: 'minimized' })
  }
  warmTimer?.cancel()
  warmTimer = $.clock.after(KEEP_WARM_MS, () => stopPlayer())
}

function stopPlayer() {
  warmTimer?.cancel()
  warmTimer = null
  const p = player
  player = null
  clearFrames()
  inputUrl = null
  void p?.return?.()
}

function clearFrames() {
  frame = null
  grid = null
  hud = null
  drawn = null
  imageDenies = 0
}

/* ------------------------------------------------------------------ setup */

/**
 * Node 18+ runs the player; a browser renders the game: Chrome or Edge if installed (every Windows
 * PC has Edge), else Chrome's headless shell, downloaded once. ../player/setup.mjs does the looking.
 */
async function setup($: Engine): Promise<string | null> {
  setupWork ??= (async () => {
    const nodeVersion = await $.process.run(['node', '--version']).catch(() => null)
    const major = Number(nodeVersion?.stdout.trim().replace(/^v/, '').split('.')[0] ?? 0)
    if (!nodeVersion || nodeVersion.exitCode !== 0 || major < 18) {
      status = 'Claude Arcade needs Node.js 18 or later on your PATH (nodejs.org).'
      return null
    }
    const dist = `${$.plugin.root}/dist`
    const found = await runSetup($, ['find', dist])
    if (!found) return null
    if (found.browser) return found.browser
    if (!found.platform) {
      status = 'Claude Arcade needs Chrome or Edge installed here (no headless Chrome download for this system).'
      return null
    }
    status = 'Downloading the game renderer (headless Chrome, about 90 MB, once)…'
    $.ui.invalidate('ui.render')
    const got = await runSetup($, ['download', dist], 15 * 60_000)
    if (!got?.browser) return null
    status = null
    return got.browser
  })()
  const chrome = await setupWork
  if (!chrome) setupWork = null
  return chrome
}

async function runSetup($: Engine, args: string[], timeoutMs = 30_000): Promise<{ platform: string | null; browser: string | null } | null> {
  const run = await $.process.run(['node', `${$.plugin.root}/player/setup.mjs`, ...args], { timeoutMs }).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  let result: { platform?: string | null; browser?: string | null; error?: string } = {}
  try {
    result = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    result = { error: run.stderr.trim() || 'setup failed' }
  }
  if (run.exitCode !== 0 || result.error) {
    status = `Couldn't set up the game renderer: ${result.error ?? run.stderr.trim()}`
    return null
  }
  return { platform: result.platform ?? null, browser: result.browser ?? null }
}

/* ------------------------------------------------------------------ the player */

async function runPlayer($: Engine) {
  if (!server) {
    status = 'No arcade server set yet: /arcade server <url> (the address from the README’s Hosting section).'
    $.ui.invalidate('ui.render')
    return
  }
  const problem = await checkServer($)
  if (problem) {
    status = problem
    $.ui.invalidate('ui.render')
    return
  }
  const chrome = await setup($)
  if (!chrome || phase === 'idle') {
    $.ui.invalidate('ui.render')
    return
  }
  const windowed = view === 'window'
  if (windowed && /chrome-headless-shell/.test(chrome)) {
    status = 'The game window needs Google Chrome or Microsoft Edge installed. /arcade view blocks plays in the terminal instead.'
    $.ui.invalidate('ui.render')
    return
  }
  // `pane`: the hidden browser painting the pane takes mouse look from the pane, not pointer lock.
  const url = `${server.replace(/\/$/, '')}/?name=${encodeURIComponent(name)}${game ? `&game=${game}` : ''}${windowed ? '' : '&pane=1'}`
  status = windowed ? `Opening the game window as ${name}…` : `Joining the arcade as ${name}…`
  $.ui.invalidate('ui.render')
  playerWindowed = windowed
  const stream = $.process.spawn({
    argv: [
      'node', `${$.plugin.root}/player/player.mjs`, '--chrome', chrome, '--url', url,
      '--view', windowed ? 'window' : view === 'blocks' ? 'cells' : 'pixels', '--columns', String(blockColumns),
      '--width', String(WIDTH), '--height', String(HEIGHT), '--fps', view === 'blocks' ? '20' : '30',
    ],
  }) as unknown as Stream
  player = stream
  let pending = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe !== 'stdout') continue
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let msg: PlayerMessage
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (player === stream) onPlayerMessage($, msg)
      }
    }
  } catch (error) {
    $.ui.log(`claudearcade player did not start: ${String(error)}`, { to: 'debug' })
  }
  if (player === stream) {
    player = null
    clearFrames()
    inputUrl = null
    if (phase === 'playing' || phase === 'countdown') {
      status = windowed ? 'The game window closed. /arcade opens it again.' : 'The game stopped. /arcade restarts it.'
      $.ui.invalidate('ui.render')
    }
  }
}

/** Why the server set can't be played on (down, or some other site), or null when it's an arcade server. */
async function checkServer($: Engine): Promise<string | null> {
  const base = server.replace(/\/$/, '')
  try {
    const res = await $.http.fetch(`${base}/health`)
    const health = JSON.parse(res.text) as { ok?: unknown; players?: unknown }
    if (health.ok === true && Array.isArray(health.players)) return null
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error)
    if (!/JSON|Unexpected|token/i.test(reason)) return `Can't reach the arcade server at ${base} (${reason}). Is it running? /arcade server <url> changes it.`
  }
  return `${base} isn't a Claude Arcade server. Set the address of yours: /arcade server http://<server-ip>:8787 (README, “Hosting the server”).`
}

type PlayerMessage = {
  input?: string
  frame?: string
  cells?: string
  columns?: number
  rows?: number
  gen?: number
  hud?: Hud | null
  error?: string
}

const isShowing = () => phase === 'playing' || phase === 'countdown'

function onPlayerMessage($: Engine, msg: PlayerMessage) {
  if (typeof msg.input === 'string') {
    inputUrl = msg.input
  } else if ((msg as { ready?: boolean }).ready && playerWindowed) {
    status = null
    $.ui.invalidate('ui.render')
  } else if (msg.frame && typeof msg.gen === 'number') {
    if (view !== 'pixels') return
    const first = !frame
    frame = { file: msg.frame, gen: msg.gen }
    if (first) {
      status = null
      $.ui.invalidate('ui.render')
    } else if (isShowing()) {
      $.ui.blit({ requestId: PANE, key: 'view', source: { file: frame.file, format: 'png', generation: frame.gen } }).then(
        result => onImageBlit($, result),
        () => {},
      )
    }
  } else if (typeof msg.cells === 'string' && msg.columns && msg.rows && typeof msg.gen === 'number') {
    if (view !== 'blocks') return
    grid = { cells: msg.cells, columns: msg.columns, rows: msg.rows, gen: msg.gen }
    // The first picture, or one of a new size, is a redraw; the rest repaint the mounted Raster.
    if (!drawn || drawn.columns !== grid.columns || drawn.rows !== grid.rows) {
      status = null
      $.ui.invalidate('ui.render')
    } else if (isShowing()) {
      $.ui.blit({ requestId: PANE, key: 'blocks', cells: grid.cells, columns: grid.columns, rows: grid.rows }).catch(() => {})
    }
  } else if (msg.hud !== undefined) {
    const switched = (msg.hud?.game ?? null) !== (hud?.game ?? null)
    hud = msg.hud
    // The menu's pick (or a switch in the browser) is the game next time.
    const picked = msg.hud?.game
    if ((picked === 'frontline' || picked === 'rally') && picked !== game) {
      game = picked
      void $.store.set('game', picked)
    }
    // Blocks and the window show the numbers; every view names the game and its controls.
    if ((view !== 'pixels' || switched) && isShowing()) $.ui.invalidate('ui.render')
  } else if (msg.error) {
    $.ui.log(`claudearcade player: ${msg.error}`, { to: 'debug' })
  }
}

/** An Image blit this terminal refused, time after time, means it draws the alt text, not pictures: go to blocks. */
function onImageBlit($: Engine, result: { deny?: string }) {
  if (!result.deny) {
    imageDenies = 0
    return
  }
  imageDenies++
  if (imageDenies === 1) $.ui.log(`claudearcade: image refused: ${result.deny}`, { to: 'debug' })
  if (imageDenies >= DENIES_BEFORE_BLOCKS && viewChoice === 'auto' && view === 'pixels' && isShowing()) {
    status = 'This terminal doesn’t show images here; drawing the game in block characters (/arcade view pixels switches back).'
    void setView($, 'blocks')
  }
}

async function setView($: Engine, next: View) {
  const restart = !!player && playerWindowed !== (next === 'window')
  adoptView(next)
  view = next
  clearFrames()
  $.ui.invalidate('ui.render')
  if (restart && isShowing()) void runPlayer($)
  else if (!playerWindowed) await postToPlayer($, 'view', { view: next === 'blocks' ? 'cells' : 'pixels', columns: blockColumns })
}

type Input = { keys: string[]; fire: boolean; aim: boolean; look?: { dx: number; dy: number } }

async function sendInput($: Engine, input: Input) {
  await postToPlayer($, 'input', input)
}

async function postToPlayer($: Engine, route: 'input' | 'view' | 'window' | 'notice', body: unknown) {
  if (!inputUrl || !player) return
  await $.http.fetch(`${inputUrl}/${route}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {})
}

/** The block picture that fits the pane: as wide as its body, no taller than leaves two lines of text. */
export function fitBlocks(bodyColumns: number, bodyRows: number): number {
  const byHeight = Math.floor(((Math.max(4, bodyRows) - 2) * 2 * WIDTH) / HEIGHT)
  return Math.max(MIN_BLOCK_COLUMNS, Math.min(MAX_BLOCK_COLUMNS, bodyColumns, byHeight))
}

/** The line under a block picture: what the game's own HUD says, which blocks are too coarse to show. */
export function statusLine(h: Hud | null): string {
  if (h?.text) return h.text
  if (!h) return game ? `${GAME_NAMES[game]} · joining` : 'Claude Arcade'
  if (typeof h.kills !== 'number') return GAME_NAMES[h.game ?? 'frontline']
  const score = `${h.kills} ${h.kills === 1 ? 'kill' : 'kills'} · ${h.deaths} ${h.deaths === 1 ? 'death' : 'deaths'}`
  const best = h.best ? ` · top rival ${h.best.name} ${h.best.kills}` : ''
  const people = h.people > 1 ? ` · ${h.people} people here` : ''
  if (!h.alive) return `Killed${h.killedBy ? ` by ${h.killedBy}` : ''} · back in ${h.respawnIn}s · ${score}${best}`
  const ammo = h.reloading ? 'reloading' : `${h.mag}/${h.reserve}`
  return `♥ ${h.hp} · ${h.weapon} ${ammo} · ${score}${best}${people}`
}

/** The game on screen: what the page last reported, else the one it was opened on (the menu if none). */
function shownGame(): Game | 'menu' {
  if (hud) return hud.game ?? 'menu'
  return game ?? 'menu'
}

function gameTitle(): string {
  const shown = shownGame()
  return shown === 'menu' ? TITLE : `${TITLE} · ${GAME_NAMES[shown]}`
}

/* ------------------------------------------------------------------ hooks */

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isOn = (await $.store.get('isOn')) === true
    const savedName = await $.store.get('name')
    name = typeof savedName === 'string' && savedName ? savedName : randomName()
    if (savedName !== name) await $.store.set('name', name)
    const savedServer = await $.store.get('server')
    if (typeof savedServer === 'string' && savedServer) server = savedServer
    const savedGame = await $.store.get('game')
    game = savedGame === 'frontline' || savedGame === 'rally' ? savedGame : null
    const savedView = await $.store.get('view')
    if (savedView === 'blocks' || savedView === 'pixels' || savedView === 'window') view = viewChoice = savedView
    await $.command.register({
      name: 'arcade',
      description: 'Play Frontline or Nova Rally with everyone waiting on Claude',
      argumentHint: '[off | game frontline|rally | view window|blocks|pixels|auto | server <url>]',
    })
    return next(e)
  })

  on('command.run', { command: 'arcade' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'off') {
      isOn = false
      await $.store.set('isOn', false)
      await handBack($)
      stopPlayer()
      return { text: 'Claude Arcade is off.' }
    }
    if (verb === 'view') {
      if (arg !== 'blocks' && arg !== 'pixels' && arg !== 'window' && arg !== 'auto') {
        return { text: `Showing the game as ${view}. /arcade view window (its own window), blocks (in any terminal), pixels (in Ghostty or kitty) or auto.` }
      }
      viewChoice = arg
      await $.store.set('view', arg)
      const next = await resolveView($)
      if (next && next !== view) await setView($, next)
      return { text: `Claude Arcade shows the game as ${arg === 'auto' ? `${next ?? view} (auto)` : arg}.` }
    }
    if (verb === 'game') {
      if (arg && arg !== 'frontline' && arg !== 'rally') return { text: 'Games: /arcade game frontline, /arcade game rally, or /arcade game for the menu.' }
      game = (arg as Game | undefined) ?? null
      await $.store.set('game', game)
      // The running game restarts into the pick (or the menu) at the next drop-in, or now if it's showing.
      stopPlayer()
      if (isShowing()) void runPlayer($)
      return { text: game ? `Claude Arcade plays ${GAME_NAMES[game]} now.` : 'Claude Arcade shows the game menu next time.' }
    }
    if (verb === 'server') {
      if (arg === 'default') {
        server = DEFAULT_SERVER
        await $.store.set('server', '')
        stopPlayer()
        return { text: `Arcade server back to the default, ${server || 'none'}.` }
      }
      if (!arg || !/^https?:\/\//.test(arg)) return { text: `Arcade server: ${server || 'not set'}. /arcade server <https://…> changes it, /arcade server default goes back to the default.` }
      server = arg
      await $.store.set('server', server)
      stopPlayer()
      return { text: `Arcade server set to ${server}.` }
    }
    isOn = true
    await $.store.set('isOn', true)
    // Opened by the person, the pane seats at any width: play right now.
    cancelTimer()
    const next = await resolveView($)
    if (!next) return { text: 'Claude Arcade draws the game in a terminal, or in its own window: /arcade view window, then /arcade.' }
    adoptView(next)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (opened.isPlaced) await startPlaying($)
    return { text: `Claude Arcade ${VERSION} is on: you drop into ${game ? GAME_NAMES[game] : 'the game menu'} as ${name} while Claude works, shown as ${view === 'window' ? 'a game window' : view}, on ${server || 'no server yet'}. /arcade off turns it off.` }
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    isDismissed = false
    if (phase === 'countdown') {
      cancelTimer()
      phase = 'playing'
      $.ui.invalidate('ui.render')
      if (playerWindowed) await postToPlayer($, 'notice', { text: '' })
    }
    armDropIn($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    isTurnRunning = false
    if (phase === 'waiting') {
      cancelTimer()
      phase = 'idle'
    } else if (phase === 'playing') {
      if (e.isAborted) await handBack($)
      else startCountdown($)
    }
    return next(e)
  })

  // Claude needs you (a permission prompt, a question): hand back at once.
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (e.tool_use_id && result.decision === 'ask') {
      if (phase === 'waiting') {
        cancelTimer()
        phase = 'idle'
      } else await handBack($)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await handBack($)
    const result = await next(e)
    armDropIn($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    if (e.origin?.kind === 'person' && isTurnRunning) isDismissed = true
    if (phase !== 'idle') {
      cancelTimer()
      phase = 'idle'
      await putAway($)
    }
    return next(e)
  })

  // The input region over the picture posts what's held and how far the mouse moved.
  on('ui.message', async ($, e) => {
    if (e.element !== 'input') return {}
    const data = e.data as Input
    if (data && Array.isArray(data.keys)) await sendInput($, data)
    return {}
  })

  on('session.end', async ($, e, next) => {
    stopPlayer()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (view === 'window') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{gameTitle()}</Text>
          <Text>{status ?? (phase === 'countdown' ? `Claude's done · back in ${countdown}` : 'Playing in the game window.')}</Text>
          {hud ? <Text bold>{statusLine(hud)}</Text> : null}
          <Text dimColor>{CONTROLS[shownGame()].window} · /arcade game switches games · /arcade off turns it off</Text>
        </Box>
      )
    }
    if (e.surface !== 'terminal') {
      return <Text>Claude Arcade shows the game in the terminal, or in its own window: /arcade view window.</Text>
    }
    const { Image, Raster, Client } = $.ui.resolve(e)
    const controls =
      phase === 'countdown' ? (
        <Text bold>Claude's done · back in {countdown}</Text>
      ) : (
        <Text dimColor>{CONTROLS[shownGame()].pane}</Text>
      )
    const joining = (
      <Box flexDirection="column" gap={1}>
        <Text bold>{gameTitle()}</Text>
        <Text>{status ?? `Joining the arcade as ${name}…`}</Text>
        <Text dimColor>/arcade off turns it off.</Text>
      </Box>
    )

    if (view === 'blocks') {
      // One cell per two pixels: the player captures the page at the width the pane has room for.
      const fit = fitBlocks(e.props.bodyColumns, e.props.scroll.bodyRows)
      if (fit !== blockColumns) {
        blockColumns = fit
        void postToPlayer($, 'view', { view: 'cells', columns: fit })
      }
      if (!grid) return joining
      drawn = { columns: grid.columns, rows: grid.rows }
      return (
        <Box flexDirection="column">
          <Raster key="blocks" columns={grid.columns} rows={grid.rows} cells={grid.cells} />
          <Box position="absolute" top={0} left={0}>
            <Client key="input" module="./input.tsx" props={{ width: WIDTH, height: HEIGHT }} width={grid.columns} height={grid.rows} />
          </Box>
          <Text bold>{statusLine(hud)}</Text>
          {controls}
        </Box>
      )
    }

    if (!frame) return joining
    // Terminal cells are about twice as tall as they are wide.
    const columns = Math.max(20, Math.min(255, e.props.bodyColumns))
    const rows = Math.max(1, Math.round((columns * HEIGHT) / WIDTH / 2))
    return (
      <Box flexDirection="column">
        <Image key="view" source={{ file: frame.file, format: 'png', generation: frame.gen }} columns={columns} rows={rows} alt={gameTitle()} />
        {/* Laid over the picture, so keys and clicks land on the game. */}
        <Box position="absolute" top={0} left={0}>
          <Client key="input" module="./input.tsx" props={{ width: WIDTH, height: HEIGHT }} width={columns} height={rows} />
        </Box>
        {controls}
      </Box>
    )
  })
}
