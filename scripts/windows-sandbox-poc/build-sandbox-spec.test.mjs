import { describe, expect, it } from 'vitest';
import { buildSandboxSpec } from './build-sandbox-spec.mjs';

function parseString(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  return buffer.toString('utf8', offset + 4, offset + 4 + length);
}

function parseStringVector(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  return Array.from({ length }, (_, index) => {
    const slot = offset + 4 + index * 4;
    return parseString(buffer, slot + buffer.readUInt32LE(slot));
  });
}

function parseStringField(buffer, table, fieldIndex) {
  const field = parseField(buffer, table, fieldIndex);
  return field === 0 ? null : parseString(buffer, field + buffer.readUInt32LE(field));
}

function parseField(buffer, table, fieldIndex) {
  const vtable = table - buffer.readInt32LE(table);
  const vtableLength = buffer.readUInt16LE(vtable);
  const entry = vtable + 4 + fieldIndex * 2;
  if (entry + 2 > vtable + vtableLength) return 0;
  const fieldOffset = buffer.readUInt16LE(entry);
  return fieldOffset === 0 ? 0 : table + fieldOffset;
}

describe('Windows process sandbox specification', () => {
  it('encodes only the workspace read/write root and explicit runtime read roots', () => {
    const bytes = buildSandboxSpec({
      workspace: 'D:\\poc\\workspace',
      readOnly: ['D:\\Node.js', 'D:\\Git', 'C:\\Windows\\System32'],
    });
    const buffer = Buffer.from(bytes);
    const table = buffer.readUInt32LE(0);

    expect(buffer.toString('ascii', 4, 8)).toBe('SBOX');
    const versionField = parseField(buffer, table, 0);
    const appContainerField = parseField(buffer, table, 1);
    const readWriteField = parseField(buffer, table, 7);
    const readOnlyField = parseField(buffer, table, 8);

    expect(parseString(buffer, versionField + buffer.readUInt32LE(versionField))).toBe('0.1.0');
    expect(buffer[appContainerField]).toBe(1);
    expect(parseField(buffer, table, 3)).toBe(0);
    expect(parseStringField(buffer, table, 6)).toBeNull();
    expect(parseStringVector(buffer, readWriteField + buffer.readUInt32LE(readWriteField))).toEqual([
      'D:\\poc\\workspace',
    ]);
    expect(parseStringVector(buffer, readOnlyField + buffer.readUInt32LE(readOnlyField))).toEqual([
      'D:\\Node.js',
      'D:\\Git',
      'C:\\Windows\\System32',
    ]);
  });

  it('encodes an explicitly requested AppContainer capability', () => {
    const buffer = Buffer.from(buildSandboxSpec({
      workspace: 'C:\\poc\\workspace',
      readOnly: ['C:\\Windows\\System32'],
      capabilities: ['registryRead'],
    }));
    const table = buffer.readUInt32LE(0);

    expect(parseStringField(buffer, table, 6)).toBe('registryRead');
  });

  it('rejects an incomplete scope before creating a blob', () => {
    expect(() => buildSandboxSpec({ workspace: '', readOnly: [] })).toThrow(/required/);
  });

  it('rejects volume-root grants and non-absolute runtime paths', () => {
    expect(() => buildSandboxSpec({
      workspace: 'C:\\',
      readOnly: ['D:\\Node.js'],
    })).toThrow(/workspace must not be a volume or share root/);
    expect(() => buildSandboxSpec({
      workspace: 'D:\\poc\\workspace',
      readOnly: ['C:\\'],
    })).toThrow(/readOnly path must not be a volume or share root/);
    expect(() => buildSandboxSpec({
      workspace: 'D:\\poc\\workspace',
      readOnly: ['Node.js'],
    })).toThrow(/readOnly path must be an absolute Windows path/);
  });
});
