import { describe, it, expect } from 'vitest';
import {
  truncateText,
  stripImages,
  isBinary,
  binaryPreview,
  sanitizeOutput,
  DEFAULT_SANITIZE,
} from './sanitize.js';

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    const text = 'short text';
    expect(truncateText(text, 100)).toBe(text);
  });

  it('truncates long text with head + tail + marker', () => {
    const text = 'a'.repeat(1000);
    const result = truncateText(text, 100);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[truncated:');
    expect(result).toMatch(/^a+/); // starts with head
    expect(result).toMatch(/a+$/); // ends with tail
  });

  it('head is ~70% of budget', () => {
    const text = 'H'.repeat(500) + 'X'.repeat(500);
    const result = truncateText(text, 100);
    // head should be ~70 chars of H
    expect(result.slice(0, 70)).toBe('H'.repeat(70));
  });
});

describe('stripImages', () => {
  it('replaces data URI images', () => {
    const text = `prefix data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== suffix`;
    const result = stripImages(text);
    expect(result).toContain('[IMAGE: base64 data URI]');
    expect(result).not.toContain('iVBORw0KGgo');
  });

  it('replaces long base64 blocks', () => {
    // isBase64Image threshold is 1000 chars; use 1200 to trigger
    const longB64 = 'A'.repeat(1200);
    const text = `before ${longB64} after`;
    const result = stripImages(text);
    expect(result).toContain('[IMAGE:');
    expect(result).not.toContain(longB64);
  });

  it('leaves short base64-like strings untouched', () => {
    const text = 'short abc123== end';
    const result = stripImages(text);
    expect(result).toBe(text);
  });
});

describe('isBinary', () => {
  it('detects null byte as binary', () => {
    const buf = Buffer.from([0x61, 0x00, 0x62]);
    expect(isBinary(buf)).toBe(true);
  });

  it('text buffer is not binary', () => {
    const buf = Buffer.from('hello world', 'utf8');
    expect(isBinary(buf)).toBe(false);
  });

  it('only checks first 1024 bytes', () => {
    const text = 'a'.repeat(2000);
    const buf = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0x00])]);
    expect(isBinary(buf)).toBe(false);
  });
});

describe('binaryPreview', () => {
  it('produces hex + ascii preview', () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const preview = binaryPreview(buf, 256);
    expect(preview).toContain('[binary: 5 bytes]');
    expect(preview).toContain('hex: 48 65 6c 6c 6f');
    expect(preview).toContain('ascii: Hello');
  });

  it('uses dot for non-printable bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x41]);
    const preview = binaryPreview(buf);
    expect(preview).toContain('ascii: ..A');
  });

  it('respects maxBytes', () => {
    const buf = Buffer.from([0x41, 0x42, 0x43, 0x44]);
    const preview = binaryPreview(buf, 2);
    expect(preview).toContain('hex: 41 42');
    expect(preview).not.toContain('43');
  });
});

describe('sanitizeOutput', () => {
  it('passes through short string unchanged', () => {
    const { output, sanitized } = sanitizeOutput('hello', DEFAULT_SANITIZE);
    expect(output).toBe('hello');
    expect(sanitized).toBe(false);
  });

  it('truncates long string', () => {
    // Use text with spaces so it isn't mistaken for base64 by stripImages
    const text = 'some sentence. '.repeat(1500);
    const { output, sanitized } = sanitizeOutput(text, DEFAULT_SANITIZE);
    expect(sanitized).toBe(true);
    expect(output.length).toBeLessThan(text.length);
    expect(output).toContain('[truncated:');
  });

  it('strips images from string', () => {
    const text = `data:image/png;base64,${'A'.repeat(600)}`;
    const { output, sanitized } = sanitizeOutput(text, DEFAULT_SANITIZE);
    expect(sanitized).toBe(true);
    expect(output).toContain('[IMAGE:');
  });

  it('returns binary preview for binary buffer', () => {
    const buf = Buffer.from([0x00, 0x01, 0x42]);
    const { output, sanitized } = sanitizeOutput(buf, DEFAULT_SANITIZE);
    expect(sanitized).toBe(true);
    expect(output).toContain('[binary:');
    expect(output).toContain('hex: 00 01 42');
  });

  it('converts text buffer to string', () => {
    const buf = Buffer.from('plain text', 'utf8');
    const { output, sanitized } = sanitizeOutput(buf, DEFAULT_SANITIZE);
    expect(sanitized).toBe(false);
    expect(output).toBe('plain text');
  });

  it('JSON-stringifies objects', () => {
    const { output } = sanitizeOutput({ a: 1, b: 'two' }, DEFAULT_SANITIZE);
    expect(output).toContain('"a": 1');
    expect(output).toContain('"b": "two"');
  });

  it('handles null/undefined', () => {
    expect(sanitizeOutput(null, DEFAULT_SANITIZE).output).toBe('');
    expect(sanitizeOutput(undefined, DEFAULT_SANITIZE).output).toBe('');
  });

  it('respects stripImages=false option', () => {
    const text = `data:image/png;base64,${'A'.repeat(600)}`;
    const { output, sanitized } = sanitizeOutput(text, {
      ...DEFAULT_SANITIZE,
      stripImages: false,
    });
    expect(sanitized).toBe(false);
    expect(output).toContain('data:image/png;base64');
  });
});
