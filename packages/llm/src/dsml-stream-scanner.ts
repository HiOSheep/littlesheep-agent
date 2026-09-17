// Single-pass DSML control-start scanner for streamed provider text.
const MAX_PENDING_MARKUP = 256;
const CONTROL_START = /<\s*(?:[｜|]\s*){1,2}DSML\s*(?:[｜|]\s*){1,2}\s*(?:calls|tool_calls)\b/iu;

export interface IncrementalDsmlControlScanner {
  append(delta: string): number;
  readonly scannedCharacters: number;
  readonly bufferedCharacters: number;
}

export function createIncrementalDsmlControlScanner(): IncrementalDsmlControlScanner {
  let scannedCharacters = 0;
  let tail = '';
  let tailOffset = 0;
  let foundAt = -1;
  let fence: { character: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;
  let linePrefix = true;
  let lineIndent = 0;
  let slashRun = 0;
  let pendingRun: { character: '`' | '~'; length: number; fencePosition: boolean } | undefined;

  const appendVisible = (character: string, quoted: boolean) => {
    tail += quoted ? '\u0000' : character;
    if (tail.length <= MAX_PENDING_MARKUP) return;
    const removed = tail.length - MAX_PENDING_MARKUP;
    tail = tail.slice(removed);
    tailOffset += removed;
  };
  const finishRun = () => {
    if (!pendingRun) return;
    const { character, length, fencePosition } = pendingRun;
    if (fencePosition && length >= 3) {
      if (!fence) fence = { character, length };
      else if (fence.character === character && length >= fence.length) fence = undefined;
    } else if (!fence && character === '`') {
      if (inlineTicks === 0) inlineTicks = length;
      else if (inlineTicks === length) inlineTicks = 0;
    }
    pendingRun = undefined;
  };
  const processCharacter = (character: string) => {
    if (character === '\n') {
      finishRun();
      appendVisible(character, Boolean(fence || inlineTicks));
      linePrefix = true;
      lineIndent = 0;
      slashRun = 0;
      return;
    }
    if (pendingRun && character === pendingRun.character) {
      pendingRun.length += 1;
      appendVisible(character, Boolean(fence || inlineTicks));
      slashRun = 0;
      return;
    }
    finishRun();
    const fencePosition = linePrefix && lineIndent <= 3;
    if (character === '`' || character === '~') {
      pendingRun = { character, length: 1, fencePosition };
      appendVisible(character, Boolean(fence || inlineTicks));
      slashRun = 0;
      return;
    }
    const quoted = Boolean(fence || inlineTicks) || (character === '<' && slashRun % 2 === 1);
    appendVisible(character, quoted);
    if (linePrefix && character === ' ' && lineIndent < 4) lineIndent += 1;
    else linePrefix = false;
    slashRun = character === '\\' ? slashRun + 1 : 0;
  };

  return {
    append(delta: string): number {
      if (!delta || foundAt >= 0) {
        scannedCharacters += delta.length;
        return foundAt;
      }
      for (const character of delta) {
        processCharacter(character);
        scannedCharacters += character.length;
        if (!tail.includes('DSML')) continue;
        const match = CONTROL_START.exec(tail);
        if (match) {
          foundAt = tailOffset + match.index;
        }
      }
      return foundAt;
    },
    get scannedCharacters() { return scannedCharacters; },
    get bufferedCharacters() { return tail.length; },
  };
}
