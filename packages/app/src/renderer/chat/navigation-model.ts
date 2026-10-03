import type { RailEntry } from './turn-navigation'

export interface NavigationTurn {
  key: string
  turn: number
  question: string
  answer: string
  keys: string[]
}

/** Questions and answers share one destination instead of duplicating a turn in the menu. */
export function navigationTurns(entries: readonly RailEntry[]): NavigationTurn[] {
  const turns: NavigationTurn[] = []
  for (const entry of entries) {
    let turn = turns.at(-1)
    if (!turn || turn.turn !== entry.turn) {
      turn = { key: entry.key, turn: entry.turn, question: '', answer: '', keys: [] }
      turns.push(turn)
    }
    turn.keys.push(entry.key)
    if (entry.role === 'user') { turn.key = entry.key; turn.question = entry.label }
    else turn.answer = entry.label
  }
  return turns
}

export function filterNavigationTurns(turns: readonly NavigationTurn[], query: string): readonly NavigationTurn[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  return turns.filter((turn) => {
    const text = `${turn.turn} ${turn.question} ${turn.answer}`.toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
}
