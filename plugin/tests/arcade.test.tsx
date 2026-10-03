import { describe, expect, mock, test } from 'claude-code/testing'

import { codeOf } from '../hooks/input.tsx'
import { fitBlocks, statusLine } from '../hooks/register.tsx'

const PANE = { component: 'Pane', requestId: 'claudearcade', props: { title: 'Claude Arcade · Frontline', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } } as const

describe('claudearcade', () => {
  test('the pane says it is joining until the first frame arrives', async ($, on) => {
    mock.store(on)
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Joining the arcade as/ })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop app is told how to play there', async ($, on) => {
    mock.store(on)
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: /\/arcade view window/ })).toBeDefined()
    await ui.unmount()
  })

  test('/arcade off turns it off and remembers', async ($, on) => {
    mock.store(on, { isOn: true })
    const result = await $.command.run({ command: 'arcade', args: 'off' })
    expect(JSON.stringify(result)).toContain('Claude Arcade is off')
  })

  test('/arcade server sets the server it joins', async ($, on) => {
    mock.store(on)
    const result = await $.command.run({ command: 'arcade', args: 'server https://arcade.test' })
    expect(JSON.stringify(result)).toContain('https://arcade.test')
    // Asked again with no URL, it reports the one it now joins.
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'server' }))).toContain('Arcade server: https://arcade.test')
    // And back to the built-in one.
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'server default' }))).toContain('back to the default, https://174-138-34-59.sslip.io')
  })

  test('terminal keys map to the game keys', () => {
    expect(codeOf({ key: 'w' })).toBe('KeyW')
    expect(codeOf({ key: 'W', shift: true })).toBe('KeyW')
    expect(codeOf({ key: ' ' })).toBe('Space')
    expect(codeOf({ key: 'left' })).toBe('ArrowLeft')
    expect(codeOf({ key: '3' })).toBe('Digit3')
    expect(codeOf({ key: '9' })).toBeNull()
    expect(codeOf({ key: 'pageup' })).toBeNull()
  })

  test('/arcade view switches between blocks, pixels and a window and remembers', async ($, on) => {
    mock.store(on)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'darwin\n', stderr: '' } }))
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view blocks' }))).toContain('as blocks')
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view' }))).toContain('Showing the game as blocks')
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view pixels' }))).toContain('as pixels')
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view window' }))).toContain('as window')
    // Auto in a Mac terminal: back to real images in the pane.
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view auto' }))).toContain('as pixels (auto)')
  })

  test('on Windows, auto plays in a game window, and the pane keeps the score', async ($, on) => {
    mock.store(on)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'win32\n', stderr: '' } }))
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'view auto' }))).toContain('as window (auto)')
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /game window/ })).toBeDefined()
    await ui.unmount()
  })

  test('the block picture fits the pane', () => {
    // As wide as the pane where it's tall enough...
    expect(fitBlocks(100, 40)).toBe(100)
    // ...narrower where its height would overflow (two lines kept for text)...
    expect(fitBlocks(200, 30)).toBe(Math.floor((28 * 2 * 640) / 360))
    // ...and never past the Raster's limits.
    expect(fitBlocks(1000, 500)).toBe(455)
    expect(fitBlocks(10, 40)).toBe(40)
  })

  test('the status line says what the HUD would', () => {
    const base = { alive: true, hp: 83, weapon: 'Kestrel AR-7', mag: 21, reserve: 90, reloading: false, respawnIn: 0, killedBy: null, kills: 3, deaths: 1, best: { name: 'Havoc', kills: 5 }, people: 2 }
    expect(statusLine(base)).toBe('♥ 83 · Kestrel AR-7 21/90 · 3 kills · 1 death · top rival Havoc 5 · 2 people here')
    expect(statusLine({ ...base, alive: false, hp: 0, killedBy: 'Rook', respawnIn: 2, people: 1 })).toBe('Killed by Rook · back in 2s · 3 kills · 1 death · top rival Havoc 5')
    expect(statusLine({ ...base, reloading: true, kills: 1, people: 1 })).toContain('Kestrel AR-7 reloading · 1 kill ·')
    expect(statusLine(null)).toBe('Claude Arcade')
    // Nova Rally and the menu say it themselves.
    expect(statusLine({ ...base, game: 'rally', text: 'Race 3 · Saturn Rings · 2nd of 8 · lap 1/2 · 27 pts' })).toBe('Race 3 · Saturn Rings · 2nd of 8 · lap 1/2 · 27 pts')
  })

  test("a server that isn't an arcade server is named as such, not drawn", async ($, on) => {
    mock.store(on)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'darwin\n', stderr: '' } }))
    on('http.fetch', () => ({ value: { status: 200, headers: {}, text: '<!doctype html><title>Some site</title>' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'arcade', args: 'server https://example.com' })
    const reply = JSON.stringify(await $.command.run({ command: 'arcade', args: '' }))
    expect(reply).toContain('Claude Arcade 0.4.10 is on')
    await new Promise(r => setTimeout(r, 50))
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /isn't a Claude Arcade server/ })).toBeDefined()
    await ui.unmount()
  })

  test('/arcade game picks the game, or brings back the menu', async ($, on) => {
    mock.store(on)
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'game rally' }))).toContain('plays Nova Rally now')
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'game' }))).toContain('game menu next time')
    expect(JSON.stringify(await $.command.run({ command: 'arcade', args: 'game tetris' }))).toContain('/arcade game frontline')
  })

  test('/arcade status says what it is doing', async ($, on) => {
    mock.store(on)
    const text = JSON.stringify(await $.command.run({ command: 'arcade', args: 'status' }))
    expect(text).toContain('Claude Arcade 0.4.10')
    expect(text).toContain('Last problem: none')
  })

  test('while Claude works, it drops into the game window after two seconds', async ($, on) => {
    mock.store(on, { isOn: true, game: 'frontline' })
    const clock = mock.clock(on)
    on('session.start', () => ({}) as never)
    on('turn.start', () => ({ turnId: 't1' }) as never)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', (_$, e) => {
      const argv = (e as { argv: string[] }).argv.join(' ')
      const stdout = argv.includes('--version') ? 'v22.0.0\n' : argv.includes('setup.mjs') ? '{"platform":"win64","browser":"C:/Edge/msedge.exe"}\n' : 'win32\n'
      return { value: { exitCode: 0, stdout, stderr: '' } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const spawned: string[][] = []
    on('process.spawn', async function* (_$, e) {
      spawned.push([...(e as { argv: string[] }).argv])
      await clock.sleep(60_000)
      return { exitCode: 0 }
    } as never)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ok":true,"players":[]}' } }))
    // A session starting (reads the saved settings), then Claude starting to work.
    await ($ as unknown as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ source: 'startup', cwd: '/tmp' }).catch(() => {})
    const turn = ($ as unknown as { turn: { start?: (e: unknown) => Promise<unknown> } }).turn
    await turn.start?.({ text: 'do a long thing', turnId: 't1' })
    await clock.settle()
    // Not yet: it waits two seconds in case Claude is quick.
    expect(spawned.length).toBe(0)
    await clock.advance(3000)
    const status = JSON.stringify(await $.command.run({ command: 'arcade', args: 'status' }))
    expect(status).toContain('dropping in (game window)')
    // The game program started, as a window that shows itself, on the arcade server.
    expect(spawned.length).toBe(1)
    expect(spawned[0]).toContain('--show')
    expect(spawned[0]!.join(' ')).toContain('https://174-138-34-59.sslip.io/?name=')
  })
})
