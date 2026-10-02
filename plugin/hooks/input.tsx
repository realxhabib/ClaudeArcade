// The input region laid over the game picture: catches keys and the mouse and
// posts what's held, plus how far the mouse moved, to the hooks module, which
// forwards it to the player (headless Chrome).
//
// Terminals report key presses but never releases, so a key counts as held
// until its auto-repeat stops (the intermission rule): long after a single
// press, since the first repeat comes late, and briefly once repeats flow.
// Mouse buttons do report releases. The mouse aims by moving over the picture.

import type { ClientModule, ClientKeyEvent } from 'claude-code'

type Props = { width: number; height: number }

type InputState = {
  presses: Map<string, { at: number; isRepeating: boolean }>
  fire: boolean
  aim: boolean
  lastX: number | null
  lastY: number | null
  dx: number
  dy: number
  posted: string
}

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120
/** Mouse look gain: game pixels of "mouse movement" per pixel of the picture crossed. */
const LOOK_GAIN = 2.2

const SPECIAL: Record<string, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  tab: 'Tab',
  return: 'Enter',
  ' ': 'Space',
  space: 'Space',
}

/** A terminal key as the KeyboardEvent.code the game reads. */
export function codeOf(e: ClientKeyEvent): string | null {
  const key = e.key
  if (SPECIAL[key]) return SPECIAL[key]!
  if (key.length !== 1) return null
  const lower = key.toLowerCase()
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`
  if (/^[1-4]$/.test(key)) return `Digit${key}`
  return null
}

const GameInput: ClientModule<Props, InputState> = (props, surface) => {
  if (surface.state === undefined) {
    const input: InputState = { presses: new Map(), fire: false, aim: false, lastX: null, lastY: null, dx: 0, dy: 0, posted: '' }

    surface.onKey(e => {
      const code = codeOf(e)
      if (!code) return
      const now = Date.now()
      const note = (c: string) => {
        const last = input.presses.get(c)
        input.presses.set(c, { at: now, isRepeating: !!last && now - last.at < HOLD_AFTER_PRESS_MS })
      }
      note(code)
      // A capital letter is the letter with Shift held: sprint.
      if (e.shift || (e.key.length === 1 && e.key !== e.key.toLowerCase())) note('ShiftLeft')
    })

    surface.onPointer(e => {
      // Picture pixels per cell, from the region's size (sub-cell positions where the terminal reports them).
      const cols = Math.max(1, surface.columns)
      const rows = Math.max(1, surface.rows)
      const x = ((e.fine?.x ?? e.x + 0.5) / cols) * props.width
      const y = ((e.fine?.y ?? e.y + 0.5) / rows) * props.height
      if (e.type === 'move' || e.type === 'down' || e.type === 'up') {
        if (input.lastX !== null && input.lastY !== null) {
          input.dx += (x - input.lastX) * LOOK_GAIN
          input.dy += (y - input.lastY) * LOOK_GAIN
        }
        input.lastX = x
        input.lastY = y
      }
      if (e.type === 'leave') {
        input.lastX = null
        input.lastY = null
      }
      if (e.type === 'down' && e.button === 'left') input.fire = true
      if (e.type === 'up' && e.button === 'left') input.fire = false
      if (e.type === 'down' && e.button === 'right') input.aim = true
      if (e.type === 'up' && e.button === 'right') input.aim = false
    })

    surface.every(33, () => {
      const now = Date.now()
      const keys: string[] = []
      for (const [code, press] of input.presses) {
        const holdMs = press.isRepeating ? HOLD_WHILE_REPEATING_MS : HOLD_AFTER_PRESS_MS
        if (now - press.at < holdMs) keys.push(code)
        else input.presses.delete(code)
      }
      keys.sort()
      const look = { dx: Math.round(input.dx), dy: Math.round(input.dy) }
      input.dx -= look.dx
      input.dy -= look.dy
      const held = JSON.stringify([keys, input.fire, input.aim])
      if (held === input.posted && !look.dx && !look.dy) return
      input.posted = held
      surface.post({ keys, fire: input.fire, aim: input.aim, look })
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return <Box width="100%" height="100%" />
}

export default GameInput
