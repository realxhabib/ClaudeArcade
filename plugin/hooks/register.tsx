// Claude Arcade: drops you into a Frontline deathmatch while Claude works, on a
// shared server with everyone else waiting on Claude, and hands you back when
// it's done (or at once when Claude needs you). The intermission pattern: an
// always-on game server (../../server), and here the real game running
// headless (../player/player.mjs, Chrome or Edge) painting its frames into a pane.
//
// Two views: "pixels", real images, where the terminal draws them (Ghostty,
// kitty), and "blocks", the picture in "▀" characters, two pixels per cell, in
// any true-colour terminal (Windows Terminal among them). Windows starts on
// blocks; elsewhere a terminal that turns out not to draw images switches to
// blocks by itself. `/arcade view` picks one.

import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const PANE = 'claudearcade'
const TITLE = 'Claude Arcade · Frontline'
/**
 * The arcade server everyone waiting on Claude joins: set it here once yours is deployed (see the
 * README's Hosting section). `/arcade server <url>` overrides it per person.
 */
const DEFAULT_SERVER = ''
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
type View = 'pixels' | 'blocks'
type Grid = { cells: string; columns: number; rows: number; gen: number }

/** The game's numbers (client/src/frontline/status.ts), for the status line under a block picture. */
export type Hud = {
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
/** What the person picked with `/arcade view`; `auto` is blocks on Windows, pixels until refused elsewhere. */
let viewChoice: 'auto' | View = 'auto'
let view: View = 'pixels'
let isWindows = false

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

async function dropIn($: Engine) {
  if (phase !== 'waiting') return
  timer = null
  const surfaces = await $.session.surfaces()
  if (!surfaces.includes('terminal')) {
    phase = 'idle'
    return
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  if (!opened.isPlaced) {
    await $.ui.close({ id: PANE })
    phase = 'idle'
    return
  }
  await startPlaying($)
}

async function startPlaying($: Engine) {
  phase = 'playing'
  warmTimer?.cancel()
  warmTimer = null
  $.ui.invalidate('ui.render')
  if (!player) void runPlayer($)
}

function startCountdown($: Engine) {
  cancelTimer()
  phase = 'countdown'
  countdown = COUNTDOWN_SECONDS
  $.ui.invalidate('ui.render')
  timer = $.clock.every(1000, () => {
    countdown--
    if (countdown > 0) $.ui.invalidate('ui.render')
    else void handBack($)
  })
}

async function handBack($: Engine) {
  cancelTimer()
  if (phase === 'idle') return
  phase = 'idle'
  await $.ui.close({ id: PANE })
  await sendInput($, { keys: [], fire: false, aim: false })
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
    isWindows = found.platform === 'win64'
    if (viewChoice === 'auto' && isWindows) view = 'blocks'
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
  const chrome = await setup($)
  if (!chrome || phase === 'idle') {
    $.ui.invalidate('ui.render')
    return
  }
  const url = `${server.replace(/\/$/, '')}/?name=${encodeURIComponent(name)}`
  status = `Joining the Frontline server as ${name}…`
  $.ui.invalidate('ui.render')
  const stream = $.process.spawn({
    argv: [
      'node', `${$.plugin.root}/player/player.mjs`, '--chrome', chrome, '--url', url,
      '--view', view === 'blocks' ? 'cells' : 'pixels', '--columns', String(blockColumns),
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
    if (phase === 'playing') {
      status = 'The game stopped. /arcade restarts it.'
      $.ui.invalidate('ui.render')
    }
  }
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
    hud = msg.hud
    if (view === 'blocks' && isShowing()) $.ui.invalidate('ui.render')
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
  view = next
  clearFrames()
  $.ui.invalidate('ui.render')
  await postToPlayer($, 'view', { view: next === 'blocks' ? 'cells' : 'pixels', columns: blockColumns })
}

type Input = { keys: string[]; fire: boolean; aim: boolean; look?: { dx: number; dy: number } }

async function sendInput($: Engine, input: Input) {
  await postToPlayer($, 'input', input)
}

async function postToPlayer($: Engine, route: 'input' | 'view', body: unknown) {
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
  if (!h) return 'Frontline · endless free for all'
  const score = `${h.kills} ${h.kills === 1 ? 'kill' : 'kills'} · ${h.deaths} ${h.deaths === 1 ? 'death' : 'deaths'}`
  const best = h.best ? ` · top rival ${h.best.name} ${h.best.kills}` : ''
  const people = h.people > 1 ? ` · ${h.people} people here` : ''
  if (!h.alive) return `Killed${h.killedBy ? ` by ${h.killedBy}` : ''} · back in ${h.respawnIn}s · ${score}${best}`
  const ammo = h.reloading ? 'reloading' : `${h.mag}/${h.reserve}`
  return `♥ ${h.hp} · ${h.weapon} ${ammo} · ${score}${best}${people}`
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
    const savedView = await $.store.get('view')
    if (savedView === 'blocks' || savedView === 'pixels') view = viewChoice = savedView
    await $.command.register({
      name: 'arcade',
      description: 'Play Frontline with everyone waiting on Claude',
      argumentHint: '[off | view blocks|pixels|auto | server <url>]',
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
      if (arg !== 'blocks' && arg !== 'pixels' && arg !== 'auto') {
        return { text: `Showing the game as ${view}. /arcade view blocks (any terminal), pixels (Ghostty, kitty) or auto.` }
      }
      viewChoice = arg
      await $.store.set('view', arg)
      const next: View = arg === 'auto' ? (isWindows ? 'blocks' : 'pixels') : arg
      if (next !== view) await setView($, next)
      return { text: `Claude Arcade shows the game as ${arg === 'auto' ? `${next} (auto)` : next}.` }
    }
    if (verb === 'server') {
      if (!arg || !/^https?:\/\//.test(arg)) return { text: `Arcade server: ${server || 'not set'}. /arcade server <https://…> changes it.` }
      server = arg
      await $.store.set('server', server)
      stopPlayer()
      return { text: `Arcade server set to ${server}.` }
    }
    isOn = true
    await $.store.set('isOn', true)
    // Opened by the person, the pane seats at any width: play right now.
    cancelTimer()
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (opened.isPlaced) await startPlaying($)
    return { text: `Claude Arcade is on: you drop into Frontline as ${name} while Claude works. /arcade off turns it off.` }
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    isDismissed = false
    if (phase === 'countdown') {
      cancelTimer()
      phase = 'playing'
      $.ui.invalidate('ui.render')
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
      await sendInput($, { keys: [], fire: false, aim: false })
      warmTimer?.cancel()
      warmTimer = $.clock.after(KEEP_WARM_MS, () => stopPlayer())
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
    if (e.surface !== 'terminal') {
      return <Text>Claude Arcade shows the game in the terminal.</Text>
    }
    const { Image, Raster, Client } = $.ui.resolve(e)
    const controls =
      phase === 'countdown' ? (
        <Text bold>Claude's done · back in {countdown}</Text>
      ) : (
        <Text dimColor>Click the game · WASD moves · mouse or arrows aim · left click fires · right click aims down sights · Shift sprints · Space jumps · R reloads · G grenade</Text>
      )
    const joining = (
      <Box flexDirection="column" gap={1}>
        <Text bold>Claude Arcade · Frontline</Text>
        <Text>{status ?? `Joining the Frontline server as ${name}…`}</Text>
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
        <Image key="view" source={{ file: frame.file, format: 'png', generation: frame.gen }} columns={columns} rows={rows} alt="Frontline" />
        {/* Laid over the picture, so keys and clicks land on the game. */}
        <Box position="absolute" top={0} left={0}>
          <Client key="input" module="./input.tsx" props={{ width: WIDTH, height: HEIGHT }} width={columns} height={rows} />
        </Box>
        {controls}
      </Box>
    )
  })
}
