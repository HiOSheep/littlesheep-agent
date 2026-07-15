export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function cleanText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

export function normalizedText(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function textTerms(value: string): Set<string> {
  const text = normalizedText(value);
  const result = new Set(text.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1));
  const compactCjk = [...text].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  for (let index = 0; index + 1 < compactCjk.length; index += 1) {
    result.add(compactCjk[index]! + compactCjk[index + 1]!);
  }
  return result;
}

export function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
