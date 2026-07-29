// @littlesheep/tools — sanitize.ts
// Sanitize tool results: truncate large output, strip images, preview binary.

export interface SanitizeOptions {
  maxOutputChars: number;
  stripImages: boolean;
}

export const DEFAULT_SANITIZE: SanitizeOptions = {
  maxOutputChars: 10000,
  stripImages: true,
};

/** Truncate a string to maxChars with a marker. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... [truncated: ${omitted} chars omitted] ...\n\n${tail}`;
}

/** Detect if a string looks like base64 image data. */
function isBase64Image(s: string): boolean {
  return /^data:image\/[a-z]+;base64,/i.test(s) || /^[A-Za-z0-9+/]{1000,}={0,2}$/.test(s.slice(0, 2000));
}

/** Strip base64 image data, replacing with a placeholder. */
export function stripImages(text: string): string {
  // Replace data URIs
  let result = text.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gi, '[IMAGE: base64 data URI]');
  // Replace long base64 blocks (heuristic)
  result = result.replace(/[A-Za-z0-9+/]{500,}={0,2}/g, (match) => {
    if (isBase64Image(match)) return `[IMAGE: ${match.length} chars base64]`;
    return match;
  });
  return result;
}

/** Check if a buffer looks like binary (non-text). */
export function isBinary(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
    const byte = buffer[i]!;
    if (byte === 0) return true; // null byte = binary
  }
  return false;
}

/** Convert a binary buffer to a hex preview. */
export function binaryPreview(buffer: Buffer, maxBytes: number = 256): string {
  const slice = buffer.slice(0, maxBytes);
  const hex = slice.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
  const ascii = Array.from(slice).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  return `[binary: ${buffer.length} bytes]\nhex: ${hex}\nascii: ${ascii}`;
}

/** Sanitize a tool result output (string or buffer). */
export function sanitizeOutput(
  output: unknown,
  opts: SanitizeOptions = DEFAULT_SANITIZE,
): { output: string; sanitized: boolean; truncated: boolean } {
  let text: string;
  let sanitized = false;
  let truncated = false;

  if (typeof output === 'string') {
    text = output;
  } else if (output instanceof Buffer) {
    if (isBinary(output)) {
      return { output: binaryPreview(output), sanitized: true, truncated: false };
    }
    text = output.toString('utf8');
  } else if (typeof output === 'object' && output !== null) {
    text = JSON.stringify(output, null, 2);
  } else {
    text = String(output ?? '');
  }

  if (opts.stripImages) {
    const stripped = stripImages(text);
    if (stripped !== text) {
      text = stripped;
      sanitized = true;
    }
  }

  if (text.length > opts.maxOutputChars) {
    text = truncateText(text, opts.maxOutputChars);
    sanitized = true;
    truncated = true;
  }

  return { output: text, sanitized, truncated };
}
