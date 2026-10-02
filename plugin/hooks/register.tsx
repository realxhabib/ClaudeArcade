// Claude Arcade: drops you into a Frontline deathmatch while Claude works, on a
// shared server with everyone else waiting on Claude, and hands you back when
// it's done (or at once when Claude needs you). The intermission pattern: an
// always-on game server (../../server), and here the real game running
// headless (../player/player.mjs, Chrome) painting its frames into a pane.

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
const CHROME_VERSIONS = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
const SYSTEM_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const NAME_STARTS = ['Idle', 'Queued', 'Pending', 'Async', 'Blocked', 'Waiting', 'Bored']
const NAME_ENDS = ['Soldier', 'Sniper', 'Grunt', 'Medic', 'Recruit', 'Dev']

type Timer = { cancel: () => void }
type Stream = AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> & { return?: () => unknown }

let isOn = false
let name = 'QueuedSoldier'
let server = DEFAULT_SERVER

//   idle      not playing
//   waiting   Claude is working; dropping in once the delay passes
//   playing   the pane is open and the game runs
//   countdown Claude is done; closing when the count reaches zero
let phase: 'idle' | 'waiting' | 'playing' | 'countdown' = 'idle'
let isTurnRunning = false
let isDismissed = false
let timer: Timer | null = null
let countdown = 0

// The running player: its output stream, the newest frame, its input socket.
let player: Stream | null = null
let frame: { file: string; gen: number } | null = null
let socket: string | null = null
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
  frame = null
  socket = null
  void p?.return?.()
}

/* ------------------------------------------------------------------ setup */

/** Node 18+ runs the player; Chrome renders the game: the person's own, or a headless one downloaded once. */
async function setup($: Engine): Promise<string | null> {
  setupWork ??= (async () => {
    const nodeVersion = await $.process.run(['node', '--version']).catch(() => null)
    const major = Number(nodeVersion?.stdout.trim().replace(/^v/, '').split('.')[0] ?? 0)
    if (!nodeVersion || nodeVersion.exitCode !== 0 || major < 18) {
      status = 'Claude Arcade needs Node.js 18 or later on your PATH (nodejs.org).'
      return null
    }
    for (const path of SYSTEM_CHROMES) if (await $.fs.exists(path)) return path
    return downloadChrome($)
  })()
  const chrome = await setupWork
  if (!chrome) setupWork = null
  return chrome
}

async function downloadChrome($: Engine): Promise<string | null> {
  const root = $.plugin.root
  const platform = await platformName($)
  if (!platform) {
    status = 'Claude Arcade runs on macOS and Linux.'
    return null
  }
  const binary = `${root}/dist/chrome-headless-shell-${platform}/chrome-headless-shell`
  if (await $.fs.exists(binary)) return binary
  status = 'Downloading the game renderer (headless Chrome, about 90 MB, once)…'
  $.ui.invalidate('ui.render')
  try {
    const versions = await $.http.fetch(CHROME_VERSIONS)
    const data = JSON.parse(versions.text) as {
      channels: { Stable: { downloads: { 'chrome-headless-shell': { platform: string; url: string }[] } } }
    }
    const url = data.channels.Stable.downloads['chrome-headless-shell'].find(d => d.platform === platform)?.url
    if (!url) throw new Error(`no headless Chrome for ${platform}`)
    const zip = `${root}/dist/chrome.zip`
    await $.process.run(['mkdir', '-p', `${root}/dist`])
    const got = await $.process.run(['curl', '-fsSL', '-o', zip, url], { timeoutMs: 15 * 60_000 })
    if (got.exitCode !== 0) throw new Error(got.stderr.trim() || 'download failed')
    const unzipped = await $.process.run(['unzip', '-q', '-o', zip, '-d', `${root}/dist`], { timeoutMs: 5 * 60_000 })
    await $.process.run(['rm', '-f', zip])
    if (unzipped.exitCode !== 0) throw new Error(unzipped.stderr.trim() || 'unzip failed')
    status = null
    return binary
  } catch (error) {
    status = `Couldn't download headless Chrome: ${String(error instanceof Error ? error.message : error)}`
    return null
  }
}

async function platformName($: Engine): Promise<string | null> {
  const uname = await $.process.run(['uname', '-sm'])
  const [system, arch] = uname.stdout.trim().split(' ')
  if (system === 'Darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (system === 'Linux' && arch === 'x86_64') return 'linux64'
  return null
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
  const id = Math.random().toString(36).slice(2, 8)
  const frames = `/tmp/claudearcade-${id}`
  socket = `/tmp/claudearcade-${id}.sock`
  const url = `${server.replace(/\/$/, '')}/?name=${encodeURIComponent(name)}`
  status = `Joining the Frontline server as ${name}…`
  $.ui.invalidate('ui.render')
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/player/player.mjs`, '--chrome', chrome, '--url', url, '--frames', frames, '--socket', socket, '--width', String(WIDTH), '--height', String(HEIGHT), '--fps', '30'],
  }) as unknown as Stream
  player = stream
  let pending = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe !== 'stdout') continue
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let msg: { frame?: string; gen?: number; error?: string; ready?: boolean }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.frame && typeof msg.gen === 'number') {
          const first = !frame
          frame = { file: msg.frame, gen: msg.gen }
          if (first) {
            status = null
            $.ui.invalidate('ui.render')
          } else if (phase === 'playing' || phase === 'countdown') {
            $.ui.blit({ requestId: PANE, key: 'view', source: { file: frame.file, format: 'png', generation: frame.gen } }).catch(() => {})
          }
        } else if (msg.error) {
          $.ui.log(`claudearcade player: ${msg.error}`, { to: 'debug' })
        }
      }
    }
  } catch (error) {
    $.ui.log(`claudearcade player did not start: ${String(error)}`, { to: 'debug' })
  }
  if (player === stream) {
    player = null
    frame = null
    socket = null
    if (phase === 'playing') {
      status = 'The game stopped. /arcade restarts it.'
      $.ui.invalidate('ui.render')
    }
  }
}

type Input = { keys: string[]; fire: boolean; aim: boolean; look?: { dx: number; dy: number } }

async function sendInput($: Engine, input: Input) {
  if (!socket || !player) return
  await $.http.fetch('http://player/input', { method: 'POST', body: JSON.stringify(input), socketPath: socket }).catch(() => {})
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
    await $.command.register({
      name: 'arcade',
      description: 'Play Frontline with everyone waiting on Claude',
      argumentHint: '[off | server <url>]',
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
      return <Text>Claude Arcade shows the game in the terminal, in Ghostty or kitty.</Text>
    }
    const { Image, Client } = $.ui.resolve(e)
    if (!frame) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Claude Arcade · Frontline</Text>
          <Text>{status ?? `Joining the Frontline server as ${name}…`}</Text>
          <Text dimColor>/arcade off turns it off.</Text>
        </Box>
      )
    }
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
        {phase === 'countdown' ? (
          <Text bold>Claude's done · back in {countdown}</Text>
        ) : (
          <Text dimColor>Click the game · WASD moves · mouse or arrows aim · left click fires · right click aims down sights · Shift sprints · Space jumps · R reloads · G grenade</Text>
        )}
      </Box>
    )
  })
}
