import type { WebExtractorKind } from '@littlesheep/types';

const MAX_EXTRACTOR_INPUT_CHARS = 2_000_000;

export interface ExtractedWebContent {
  readonly title?: string;
  readonly publishedAt?: string;
  readonly extractor: WebExtractorKind;
  readonly content: string;
  /** Normalized content before the character limit, retained only in memory for hashing. */
  readonly fullContent: string;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** Convert a bounded HTTP body into model-readable text without executing page code. */
export function extractWebContent(
  body: Uint8Array,
  contentType: string | undefined,
  maxChars: number,
): ExtractedWebContent {
  const normalizedType = (contentType ?? '').toLowerCase().split(';', 1)[0]!.trim();
  const decoded = decodeUtf8(body);
  const sourceTruncated = decoded.length > MAX_EXTRACTOR_INPUT_CHARS;
  const text = sourceTruncated ? decoded.slice(0, MAX_EXTRACTOR_INPUT_CHARS) : decoded;
  if (normalizedType === 'text/html' || normalizedType === 'application/xhtml+xml' || looksLikeHtml(text)) {
    return extractHtml(text, maxChars, sourceTruncated);
  }
  if (normalizedType === 'application/json' || normalizedType.endsWith('+json')) {
    return limitContent({
      extractor: 'json',
      content: formatJson(text),
      warnings: [],
    }, maxChars, sourceTruncated);
  }
  if (normalizedType === 'text/plain' || normalizedType === '' || normalizedType.startsWith('text/')) {
    return limitContent({ extractor: 'plain_text', content: text, warnings: [] }, maxChars, sourceTruncated);
  }
  return {
    extractor: 'none',
    content: '',
    fullContent: '',
    truncated: false,
    warnings: [`unsupported content type: ${normalizedType || 'unknown'}`],
  };
}

function extractHtml(html: string, maxChars: number, sourceTruncated: boolean): ExtractedWebContent {
  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const publishedAt = firstMatch(html, /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date|publish(?:ed)?)["'][^>]*content=["']([^"']+)["']/iu)
    ?? firstMatch(html, /<time\b[^>]*datetime=["']([^"']+)["']/iu);
  let value = html;
  // These elements can contain scripts, hidden controls, navigation or other
  // page chrome. Their contents are not useful evidence and may contain
  // instruction-shaped prompt injection.
  value = value.replace(/<!--[\s\S]*?-->/gu, ' ');
  value = value.replace(/<(?:script|style|noscript|template|svg|iframe|canvas|object|embed|nav|footer|aside|form|button|select|option)\b[\s\S]*?<\/(?:script|style|noscript|template|svg|iframe|canvas|object|embed|nav|footer|aside|form|button|select|option)>/giu, ' ');
  value = value.replace(/<[^>]*(?:hidden\b|aria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\/[^>]+>/giu, ' ');
  value = value
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, text: string) => `\n\n${'#'.repeat(Number(level))} ${text}\n\n`)
    .replace(/<(?:p|div|section|article|header|main|blockquote|li|dt|dd)\b[^>]*>/giu, '\n\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '\n- ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, '[$2]($1)')
    .replace(/<[^>]+>/gu, ' ');
  value = decodeHtmlEntities(value)
    .replace(/[ \t\v\f]+/gu, ' ')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return limitContent({
    ...(cleanOptional(title) ? { title: decodeHtmlEntities(title!) } : {}),
    ...(cleanOptional(publishedAt) ? { publishedAt: publishedAt!.trim() } : {}),
    extractor: 'readability',
    content: value,
    warnings: [],
  }, maxChars, sourceTruncated);
}

function limitContent(
  value: Omit<ExtractedWebContent, 'truncated' | 'content' | 'fullContent'> & { content: string },
  maxChars: number,
  sourceTruncated = false,
): ExtractedWebContent {
  const boundedMax = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const fullContent = cleanExtractedText(value.content);
  const truncated = sourceTruncated || fullContent.length > boundedMax;
  return {
    ...value,
    warnings: sourceTruncated ? [...value.warnings, 'source exceeded the extractor input limit'] : value.warnings,
    fullContent,
    content: fullContent.length > boundedMax ? fullContent.slice(0, boundedMax) : fullContent,
    truncated,
  };
}

function cleanExtractedText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
}

function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  } catch {
    return Buffer.from(body).toString('utf8');
  }
}

function formatJson(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed, null, 2) ?? text;
  } catch {
    return text;
  }
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<!doctype\s+html\b/iu.test(text) || /<html\b|<body\b|<article\b/iu.test(text.slice(0, 16_384));
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return pattern.exec(value)?.[1]?.trim() || undefined;
}

function cleanOptional(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    ndash: '–',
    mdash: '—',
    hellip: '…',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[lower] ?? match;
  });
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}
