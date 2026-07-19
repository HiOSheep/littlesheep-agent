// Conservative input-line tracking for interactive terminal authorization.

export type TerminalEscapeMode = 'none' | 'escape' | 'csi' | 'osc'

export interface TerminalInputState {
  line: string
  uncertain: boolean
  escapeMode: TerminalEscapeMode
  afterCarriageReturn: boolean
}

export interface TerminalInputCommand {
  command: string
  uncertain: boolean
}

export interface TerminalInputAnalysis {
  commands: TerminalInputCommand[]
  nextState: TerminalInputState
}

export const EMPTY_TERMINAL_INPUT_STATE: TerminalInputState = {
  line: '',
  uncertain: false,
  escapeMode: 'none',
  afterCarriageReturn: false,
}

/**
 * Track only enough of the local editing state to authorize a line before its
 * Enter key reaches the shell. Unknown editing sequences fail closed.
 */
export function analyzeTerminalInput(
  state: TerminalInputState,
  data: string,
): TerminalInputAnalysis {
  let line = state.line
  let uncertain = state.uncertain
  let escapeMode = state.escapeMode
  let afterCarriageReturn = state.afterCarriageReturn
  const commands: TerminalInputCommand[] = []

  for (const char of data) {
    if (afterCarriageReturn) {
      afterCarriageReturn = false
      if (char === '\n') continue
    }

    if (escapeMode === 'osc') {
      if (char === '\x07') {
        escapeMode = 'none'
      } else if (char === '\x1b') {
        escapeMode = 'escape'
      }
      continue
    }

    if (escapeMode === 'csi') {
      if (char >= '@' && char <= '~') escapeMode = 'none'
      continue
    }

    if (escapeMode === 'escape') {
      escapeMode = char === '[' ? 'csi' : char === ']' ? 'osc' : 'none'
      continue
    }

    if (char === '\x1b') {
      escapeMode = 'escape'
      uncertain = true
      continue
    }

    if (char === '\r' || char === '\n') {
      commands.push({ command: line.trim(), uncertain })
      line = ''
      uncertain = false
      afterCarriageReturn = char === '\r'
      continue
    }

    if (char === '\x03' || char === '\x04') {
      line = ''
      uncertain = false
      continue
    }

    if (char === '\x08' || char === '\x7f') {
      line = removeLastCodePoint(line)
      continue
    }

    if (char === '\x15') {
      line = ''
      continue
    }

    if (char === '\x17') {
      line = line.replace(/\s*\S+\s*$/u, '')
      continue
    }

    if (char === '\t' || char < ' ') {
      uncertain = true
      continue
    }

    line += char
  }

  return {
    commands,
    nextState: {
      line,
      uncertain,
      escapeMode,
      afterCarriageReturn,
    },
  }
}

function removeLastCodePoint(value: string): string {
  const points = Array.from(value)
  points.pop()
  return points.join('')
}
