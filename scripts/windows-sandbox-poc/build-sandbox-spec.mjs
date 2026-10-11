import { writeFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Builder } from 'flatbuffers';

function parseArgs(argv) {
  const options = { readOnly: [], capabilities: [], disallowWin32k: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--read-only') options.readOnly.push(value);
    else if (key === '--capability') options.capabilities.push(value);
    else if (key === '--disallow-win32k') options.disallowWin32k = value === 'true';
    else if (key === '--out') options.output = value;
    else if (key === '--workspace') options.workspace = value;
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  if (!options.output || !options.workspace || options.readOnly.length === 0) {
    throw new Error('Usage: build-sandbox-spec.mjs --out FILE --workspace DIR --read-only DIR [--read-only DIR ...]');
  }
  return options;
}

function createStringVector(builder, offsets) {
  builder.startVector(4, offsets.length, 4);
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    builder.addOffset(offsets[index]);
  }
  return builder.endVector();
}

function assertScopedWindowsDirectory(path, label) {
  if (typeof path !== 'string' || !win32.isAbsolute(path)) {
    throw new TypeError(`${label} must be an absolute Windows path`);
  }
  const normalized = win32.resolve(path).replace(/[\\/]+$/, '').toLowerCase();
  const root = win32.parse(path).root.replace(/[\\/]+$/, '').toLowerCase();
  if (normalized === root) throw new TypeError(`${label} must not be a volume or share root`);
}

export function buildSandboxSpec({ workspace, readOnly, capabilities = [], disallowWin32k = false }) {
  if (!workspace || !Array.isArray(readOnly) || readOnly.length === 0) {
    throw new TypeError('workspace and at least one readOnly path are required');
  }
  assertScopedWindowsDirectory(workspace, 'workspace');
  for (const path of readOnly) assertScopedWindowsDirectory(path, 'readOnly path');
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== 'string' || capability.length === 0)) {
    throw new TypeError('capabilities must be an array of non-empty strings');
  }

  const builder = new Builder(1024);
  const version = builder.createString('0.1.0');
  const capabilityList = capabilities.length > 0 ? builder.createString(capabilities.join(',')) : 0;
  const workspacePath = builder.createString(workspace);
  const readOnlyPaths = readOnly.map((path) => builder.createString(path));
  const readWriteVector = createStringVector(builder, [workspacePath]);
  const readOnlyVector = createStringVector(builder, readOnlyPaths);

  // Slot indexes 0..8 mirror the documented SandboxSpec field order in the
  // checked-in .fbs subset. The host probe showed the Win32k-disable mitigation
  // breaks CLI process initialization, so the compatibility default leaves it
  // off. No network capability is added; AppContainer defaults to no network.
  builder.startObject(9);
  builder.addFieldOffset(0, version, 0);
  builder.addFieldInt8(1, 1, 0);
  if (disallowWin32k) builder.addFieldInt8(3, 1, 0);
  builder.addFieldOffset(6, capabilityList, 0);
  builder.addFieldOffset(7, readWriteVector, 0);
  builder.addFieldOffset(8, readOnlyVector, 0);
  const root = builder.endObject();
  builder.finish(root, 'SBOX');
  return Buffer.from(builder.asUint8Array());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const spec = buildSandboxSpec(options);
  await writeFile(options.output, spec, { flag: 'wx' });
  process.stdout.write(`${options.output}\n`);
}
