import { describe, expect, it } from 'vitest';
import { createIncrementalDsmlControlScanner } from './dsml-stream-scanner.js';

const control = '<｜DSML｜ calls><｜DSML｜ invoke name="exec">';

describe('incremental DSML stream scanner', () => {
  it('detects an unquoted control marker across every character boundary', () => {
    const scanner = createIncrementalDsmlControlScanner();
    let result = -1;
    for (const character of `prefix\n${control}`) result = scanner.append(character);
    expect(result).toBe('prefix\n'.length);
  });

  it('keeps fenced, inline and escaped controls inert across tiny chunks', () => {
    for (const text of [`\`\`\`xml\n${control}\n\`\`\``, `example \`${control}\``, `\\${control}`]) {
      const scanner = createIncrementalDsmlControlScanner();
      let result = -1;
      for (const character of text) result = scanner.append(character);
      expect(result).toBe(-1);
    }
  });

  it('HA-01-10 scans 100,000 streamed characters once with bounded pending state', () => {
    const scanner = createIncrementalDsmlControlScanner();
    const text = `\`\`\`xml\n${'x'.repeat(49_900)}${control}${'y'.repeat(49_900)}\n\`\`\``;
    let result = -1;
    for (const character of text) result = scanner.append(character);
    expect(result).toBe(-1);
    expect(scanner.scannedCharacters).toBe(text.length);
    expect(scanner.bufferedCharacters).toBeLessThanOrEqual(256);
  });
});
