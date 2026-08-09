import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function normalizeFingerprintPath(value) {
  return String(value).split(sep).join('/');
}

export function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableJsonValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestContract(value) {
  return sha256(stableJson(value));
}

function isOutside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export async function assertCanonicalPathInside(root, candidate, {
  allowRoot = false,
  rejectSymlink = false,
  label = 'path',
} = {}) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const lexicalRelative = relative(absoluteRoot, absoluteCandidate);
  if (isOutside(absoluteRoot, absoluteCandidate) || (!allowRoot && lexicalRelative === '')) {
    throw new Error(`${label} is outside the allowed boundary: ${absoluteCandidate}`);
  }

  if (rejectSymlink) {
    const rootEntry = await lstat(absoluteRoot);
    if (rootEntry.isSymbolicLink()) {
      throw new Error(`${label} boundary root is a symbolic link: ${absoluteRoot}`);
    }
    const segments = lexicalRelative.split(sep).filter(Boolean);
    let current = absoluteRoot;
    for (const segment of segments) {
      current = resolve(current, segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`);
      }
    }
  }

  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(absoluteRoot),
    realpath(absoluteCandidate),
  ]);
  if (isOutside(canonicalRoot, canonicalCandidate) || (!allowRoot && canonicalRoot === canonicalCandidate)) {
    throw new Error(`${label} resolves outside the allowed boundary: ${absoluteCandidate}`);
  }
  return canonicalCandidate;
}

async function fingerprintFile(boundaryRoot, absolutePath, logicalPath) {
  await assertCanonicalPathInside(boundaryRoot, absolutePath, {
    rejectSymlink: true,
    label: `fingerprint input ${logicalPath}`,
  });
  const before = await stat(absolutePath);
  if (!before.isFile()) throw new Error(`Fingerprint input is not a file: ${logicalPath}`);
  const bytes = await readFile(absolutePath);
  const after = await stat(absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Fingerprint input changed while it was being read: ${logicalPath}`);
  }
  return {
    path: normalizeFingerprintPath(logicalPath),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function collectPath(boundaryRoot, absolutePath, logicalPath, entries, shouldInclude) {
  await assertCanonicalPathInside(boundaryRoot, absolutePath, {
    rejectSymlink: true,
    label: `fingerprint path ${logicalPath}`,
  });
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) throw new Error(`Fingerprint path is a symbolic link: ${logicalPath}`);
  if (info.isFile()) {
    if (shouldInclude(logicalPath, false)) {
      entries.set(normalizeFingerprintPath(logicalPath), await fingerprintFile(
        boundaryRoot,
        absolutePath,
        logicalPath,
      ));
    }
    return;
  }
  if (!info.isDirectory()) throw new Error(`Fingerprint path is not a regular file or directory: ${logicalPath}`);
  if (!shouldInclude(logicalPath, true)) return;

  const children = await readdir(absolutePath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const childLogicalPath = logicalPath ? `${normalizeFingerprintPath(logicalPath)}/${child.name}` : child.name;
    if (!shouldInclude(childLogicalPath, child.isDirectory())) continue;
    if (child.isSymbolicLink()) {
      throw new Error(`Fingerprint path is a symbolic link: ${childLogicalPath}`);
    }
    await collectPath(
      boundaryRoot,
      resolve(absolutePath, child.name),
      childLogicalPath,
      entries,
      shouldInclude,
    );
  }
}

export async function fingerprintPaths(boundaryRoot, paths, {
  shouldInclude = () => true,
} = {}) {
  const absoluteRoot = resolve(boundaryRoot);
  await realpath(absoluteRoot);
  const entries = new Map();
  const normalizedPaths = [...new Set(paths.map((value) => normalizeFingerprintPath(value)))]
    .sort((left, right) => left.localeCompare(right));

  for (const logicalPath of normalizedPaths) {
    if (!logicalPath || logicalPath === '.' || logicalPath.startsWith('../') || isAbsolute(logicalPath)) {
      throw new Error(`Fingerprint path must be a repository-relative path: ${logicalPath}`);
    }
    await collectPath(
      absoluteRoot,
      resolve(absoluteRoot, logicalPath),
      logicalPath,
      entries,
      shouldInclude,
    );
  }

  const files = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    digest: digestContract(files),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
  };
}

export async function atomicWriteJson(path, value, { boundaryRoot = dirname(path) } = {}) {
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  await assertCanonicalPathInside(boundaryRoot, parent, {
    allowRoot: true,
    rejectSymlink: true,
    label: 'atomic JSON destination directory',
  });

  try {
    const existing = await lstat(absolutePath);
    if (existing.isSymbolicLink()) throw new Error(`Atomic JSON destination is a symbolic link: ${absolutePath}`);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
  }

  const temporaryPath = resolve(parent, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(stableJsonValue(value), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
