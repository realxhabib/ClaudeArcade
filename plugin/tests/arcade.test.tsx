import { describe, expect, mock, test } from 'claude-code/testing'

import { codeOf } from '../hooks/input.tsx'

const PANE = { component: 'Pane', requestId: 'claudearcade', props: { title: 'Claude Arcade · Frontline', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } } as const

describe('claudearcade', () => {
  test('the pane says it is joining until the first frame arrives', async ($, on) => {
    mock.store(on)
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Joining the Frontline server as/ })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop app gets a pointer to the terminal', async ($, on) => {
    mock.store(on)
    const ui = await $.ui.mount({ plugin: 'claudearcade', surface: 'desktop', ...PANE })
    expect(await ui.find({ type: 'Text', text: /in the terminal/ })).toBeDefined()
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
})
