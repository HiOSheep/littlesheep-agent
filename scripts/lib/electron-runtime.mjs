import { createRequire } from 'node:module';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertCanonicalPathInside, digestContract, normalizeFingerprintPath, sha256 } from './build-fingerprint.mjs';

const APP_BUILD_MANIFEST_VERSION = 1;
const APP_BUILD_MANIFEST_NAME = '.littlesheep-build-fingerprint.json';
const verifiedExecutableCache = new Map();

function isOutside(root, candidate) {
  const path = relative(root, candidate);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function fileIdentity(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Electron executable is not a file: ${path}`);
  const bytes = await readFile(path);
  return {
    path: normalizeFingerprintPath(await realpath(path)),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function fileIdentitySync(path) {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`Electron executable is not a file: ${path}`);
  const bytes = readFileSync(path);
  return {
    path: normalizeFingerprintPath(realpathSync(path)),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function assertCanonicalPathInsideSync(root, candidate, {
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
    const rootEntry = lstatSync(absoluteRoot);
    if (rootEntry.isSymbolicLink()) {
      throw new Error(`${label} boundary root is a symbolic link: ${absoluteRoot}`);
    }
    let current = absoluteRoot;
    for (const segment of lexicalRelative.split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`);
      }
    }
  }

  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalCandidate = realpathSync(absoluteCandidate);
  if (isOutside(canonicalRoot, canonicalCandidate) || (!allowRoot && canonicalRoot === canonicalCandidate)) {
    throw new Error(`${label} resolves outside the allowed boundary: ${absoluteCandidate}`);
  }
  return canonicalCandidate;
}

function resolveElectronInstallationSync(repoRoot) {
  const appManifestPath = resolve(repoRoot, 'packages/app/package.json');
  const appRequire = createRequire(appManifestPath);
  let electronManifestPath;
  try {
    electronManifestPath = appRequire.resolve('electron/package.json');
  } catch (error) {
    throw new Error(`Unable to resolve the Electron package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packageRoot = realpathSync(dirname(electronManifestPath));
  const manifest = JSON.parse(readFileSync(electronManifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`Electron package has no valid version: ${electronManifestPath}`);
  }
  const binaryRelativePath = readFileSync(join(packageRoot, 'path.txt'), 'utf8').trim();
  if (!binaryRelativePath || isAbsolute(binaryRelativePath)) {
    throw new Error(`Electron path.txt contains an invalid executable path: ${binaryRelativePath}`);
  }
  const distRoot = realpathSync(join(packageRoot, 'dist'));
  const executablePath = realpathSync(join(distRoot, binaryRelativePath));
  if (isOutside(distRoot, executablePath)) {
    throw new Error(`Electron executable resolves outside its package dist directory: ${executablePath}`);
  }
  if (!statSync(executablePath).isFile()) {
    throw new Error(`Electron executable is not a file: ${executablePath}`);
  }
  return {
    version: manifest.version.trim(),
    packageRoot,
    executablePath,
  };
}

export async function resolveElectronInstallation(repoRoot) {
  const appManifestPath = resolve(repoRoot, 'packages/app/package.json');
  const appRequire = createRequire(appManifestPath);
  let electronManifestPath;
  try {
    electronManifestPath = appRequire.resolve('electron/package.json');
  } catch (error) {
    throw new Error(`Unable to resolve the Electron package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packageRoot = await realpath(dirname(electronManifestPath));
  const manifest = JSON.parse(await readFile(electronManifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`Electron package has no valid version: ${electronManifestPath}`);
  }
  const binaryRelativePath = (await readFile(join(packageRoot, 'path.txt'), 'utf8')).trim();
  if (!binaryRelativePath || isAbsolute(binaryRelativePath)) {
    throw new Error(`Electron path.txt contains an invalid executable path: ${binaryRelativePath}`);
  }
  const distRoot = await realpath(join(packageRoot, 'dist'));
  const executablePath = await realpath(join(distRoot, binaryRelativePath));
  if (isOutside(distRoot, executablePath)) {
    throw new Error(`Electron executable resolves outside its package dist directory: ${executablePath}`);
  }
  return {
    version: manifest.version.trim(),
    packageRoot,
    executablePath,
  };
}

function expectedPreparedName(sourcePath) {
  return `LittleSheep${extname(sourcePath)}`;
}

function assertRuntimeEntrySync(path, type, label) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} is a symbolic link: ${path}`);
  if (type === 'file' && !info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (type === 'directory' && !info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

async function assertRuntimeEntry(path, type, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} is a symbolic link: ${path}`);
  if (type === 'file' && !info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (type === 'directory' && !info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function fingerprintPreparedElectronRuntimeSync(repoRoot, preparedExecutablePath, installation) {
  const runtimeRoot = resolve(repoRoot, 'packages/app/runtime');
  const preparedPath = resolve(preparedExecutablePath);
  const preparedInfo = lstatSync(preparedPath);
  if (preparedInfo.isSymbolicLink()) {
    throw new Error(`Prepared Electron executable is a symbolic link: ${preparedPath}`);
  }
  assertCanonicalPathInsideSync(runtimeRoot, preparedPath, {
    rejectSymlink: true,
    label: 'prepared Electron executable',
  });
  if (basename(preparedPath) !== expectedPreparedName(installation.executablePath)) {
    throw new Error(`Prepared Electron executable has an unexpected name: ${preparedPath}`);
  }

  const runtimeDirectory = dirname(preparedPath);
  const expectedDirectoryPrefix = `electron-v${installation.version}-${process.platform}-${process.arch}`;
  const runtimeDirectoryName = basename(runtimeDirectory);
  if (!new RegExp(`^${expectedDirectoryPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-\\d+)?$`).test(runtimeDirectoryName)) {
    throw new Error(
      `Prepared Electron runtime directory does not match ${installation.version}/${process.platform}/${process.arch}: ${runtimeDirectory}`,
    );
  }

  const runtimeEntries = [
    [join(runtimeDirectory, 'version'), 'file', 'prepared Electron runtime version'],
    [join(runtimeDirectory, 'locales'), 'directory', 'prepared Electron runtime locales'],
    [join(runtimeDirectory, 'resources'), 'directory', 'prepared Electron runtime resources'],
    [join(runtimeDirectory, 'resources', 'default_app.asar'), 'file', 'prepared Electron default app'],
  ];
  for (const [path, type, label] of runtimeEntries) {
    assertCanonicalPathInsideSync(runtimeDirectory, path, { rejectSymlink: true, label });
    assertRuntimeEntrySync(path, type, label);
  }
  const runtimeVersion = readFileSync(join(runtimeDirectory, 'version'), 'utf8').trim();
  if (runtimeVersion !== installation.version) {
    throw new Error(
      `Prepared Electron runtime version mismatch: expected ${installation.version}, found ${runtimeVersion || 'empty'}`,
    );
  }

  const sourceExecutable = fileIdentitySync(installation.executablePath);
  const preparedExecutable = fileIdentitySync(preparedPath);
  if (sourceExecutable.size !== preparedExecutable.size || sourceExecutable.sha256 !== preparedExecutable.sha256) {
    throw new Error('Prepared Electron executable does not match the installed Electron executable.');
  }

  return {
    electronVersion: installation.version,
    platform: process.platform,
    arch: process.arch,
    packageRoot: normalizeFingerprintPath(realpathSync(installation.packageRoot)),
    sourceExecutable,
    preparedExecutable,
    preparedRuntimeDirectory: normalizeFingerprintPath(realpathSync(runtimeDirectory)),
  };
}

function readAppBuildRuntimeSidecarSync(repoRoot) {
  const outRoot = resolve(repoRoot, 'packages/app/out');
  const path = resolve(outRoot, APP_BUILD_MANIFEST_NAME);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot inspect App build fingerprint sidecar ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`App build fingerprint sidecar is not a regular file: ${path}`);
  }
  assertCanonicalPathInsideSync(outRoot, path, {
    rejectSymlink: true,
    label: 'App build fingerprint sidecar',
  });
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read App build fingerprint sidecar ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== APP_BUILD_MANIFEST_VERSION
    || manifest.kind !== 'littlesheep-app-build'
    || !manifest.runtime || typeof manifest.runtime !== 'object'
    || typeof manifest.runtime.preparedExecutable?.path !== 'string'
    || !isAbsolute(manifest.runtime.preparedExecutable.path)) {
    throw new Error(`App build fingerprint sidecar has an invalid runtime contract: ${path}`);
  }
  return { path, manifest };
}

function cacheToken(paths) {
  return JSON.stringify(paths.map((path) => {
    const lexicalPath = resolve(path);
    const lexicalInfo = lstatSync(lexicalPath);
    if (lexicalInfo.isSymbolicLink()) throw new Error(`Verified Electron runtime path is a symbolic link: ${lexicalPath}`);
    const info = statSync(lexicalPath);
    return [normalizeFingerprintPath(realpathSync(lexicalPath)), info.size, info.mtimeMs, info.ctimeMs];
  }));
}

function preparedRuntimeCandidates(repoRoot, installation) {
  const runtimeRoot = resolve(repoRoot, 'packages/app/runtime');
  const rootInfo = lstatSync(runtimeRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Prepared Electron runtime root is not a regular directory: ${runtimeRoot}`);
  }
  const prefix = `electron-v${installation.version}-${process.platform}-${process.arch}`;
  return readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && (entry.name === prefix || entry.name.startsWith(`${prefix}-`)))
    .map((entry) => join(runtimeRoot, entry.name, expectedPreparedName(installation.executablePath)))
    .sort((left, right) => right.localeCompare(left));
}

export function resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest = false } = {}) {
  const canonicalRepoRoot = realpathSync(resolve(repoRoot));
  const installation = resolveElectronInstallationSync(canonicalRepoRoot);
  const sidecar = readAppBuildRuntimeSidecarSync(canonicalRepoRoot);
  if (requireAppBuildManifest && !sidecar) {
    throw new Error(`App build fingerprint sidecar is unavailable: ${resolve(
      canonicalRepoRoot,
      'packages/app/out',
      APP_BUILD_MANIFEST_NAME,
    )}`);
  }

  if (sidecar) {
    const preparedPath = resolve(sidecar.manifest.runtime.preparedExecutable.path);
    const token = cacheToken([
      sidecar.path,
      installation.executablePath,
      preparedPath,
    ]);
    const cached = verifiedExecutableCache.get(canonicalRepoRoot);
    if (cached?.token === token) return cached.path;

    let identity;
    try {
      identity = fingerprintPreparedElectronRuntimeSync(
        canonicalRepoRoot,
        preparedPath,
        installation,
      );
    } catch (error) {
      throw new Error(`App build fingerprint sidecar references an invalid Electron runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (digestContract(electronRuntimeContract(identity)) !== digestContract(sidecar.manifest.runtime)) {
      throw new Error('App build fingerprint sidecar Electron runtime contract does not match the installed runtime.');
    }
    verifiedExecutableCache.set(canonicalRepoRoot, { path: identity.preparedExecutable.path, token });
    return identity.preparedExecutable.path;
  }

  const failures = [];
  for (const candidate of preparedRuntimeCandidates(canonicalRepoRoot, installation)) {
    try {
      const token = cacheToken([installation.executablePath, candidate]);
      const cached = verifiedExecutableCache.get(canonicalRepoRoot);
      if (cached?.token === token) return cached.path;
      const identity = fingerprintPreparedElectronRuntimeSync(canonicalRepoRoot, candidate, installation);
      verifiedExecutableCache.set(canonicalRepoRoot, { path: identity.preparedExecutable.path, token });
      return identity.preparedExecutable.path;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const detail = failures.length > 0 ? ` ${failures.join(' | ')}` : '';
  throw new Error(`No verified Electron runtime is available; run the App build first.${detail}`);
}

export async function fingerprintPreparedElectronRuntime(repoRoot, preparedExecutablePath, {
  installation,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const resolvedInstallation = installation ?? await resolveElectronInstallation(repoRoot);
  const runtimeRoot = resolve(repoRoot, 'packages/app/runtime');
  const preparedPath = resolve(preparedExecutablePath);
  const runtimeRootInfo = await lstat(runtimeRoot);
  if (runtimeRootInfo.isSymbolicLink() || !runtimeRootInfo.isDirectory()) {
    throw new Error(`Prepared Electron runtime root is not a regular directory: ${runtimeRoot}`);
  }
  const preparedInfo = await lstat(preparedPath);
  if (preparedInfo.isSymbolicLink()) {
    throw new Error(`Prepared Electron executable is a symbolic link: ${preparedPath}`);
  }
  await assertCanonicalPathInside(runtimeRoot, preparedPath, {
    rejectSymlink: true,
    label: 'prepared Electron executable',
  });
  if (basename(preparedPath) !== expectedPreparedName(resolvedInstallation.executablePath)) {
    throw new Error(`Prepared Electron executable has an unexpected name: ${preparedPath}`);
  }

  const runtimeDirectory = dirname(preparedPath);
  const expectedDirectoryPrefix = `electron-v${resolvedInstallation.version}-${platform}-${arch}`;
  if (!new RegExp(`^${expectedDirectoryPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-\\d+)?$`).test(basename(runtimeDirectory))) {
    throw new Error(
      `Prepared Electron runtime directory does not match ${resolvedInstallation.version}/${platform}/${arch}: ${runtimeDirectory}`,
    );
  }
  const requiredRuntimeEntries = [
    [join(runtimeDirectory, 'version'), 'file', 'prepared Electron runtime version'],
    [join(runtimeDirectory, 'locales'), 'directory', 'prepared Electron runtime locales'],
    [join(runtimeDirectory, 'resources'), 'directory', 'prepared Electron runtime resources'],
    [join(runtimeDirectory, 'resources', 'default_app.asar'), 'file', 'prepared Electron default app'],
  ];
  for (const [path, type, label] of requiredRuntimeEntries) {
    await assertCanonicalPathInside(runtimeDirectory, path, {
      rejectSymlink: true,
      label,
    });
    await assertRuntimeEntry(path, type, label);
  }
  const runtimeVersion = (await readFile(join(runtimeDirectory, 'version'), 'utf8')).trim();
  if (runtimeVersion !== resolvedInstallation.version) {
    throw new Error(
      `Prepared Electron runtime version mismatch: expected ${resolvedInstallation.version}, found ${runtimeVersion || 'empty'}`,
    );
  }

  const [sourceExecutable, preparedExecutable] = await Promise.all([
    fileIdentity(resolvedInstallation.executablePath),
    fileIdentity(preparedPath),
  ]);
  if (sourceExecutable.size !== preparedExecutable.size || sourceExecutable.sha256 !== preparedExecutable.sha256) {
    throw new Error('Prepared Electron executable does not match the installed Electron executable.');
  }

  return {
    electronVersion: resolvedInstallation.version,
    platform,
    arch,
    packageRoot: normalizeFingerprintPath(await realpath(resolvedInstallation.packageRoot)),
    sourceExecutable,
    preparedExecutable,
    preparedRuntimeDirectory: normalizeFingerprintPath(await realpath(runtimeDirectory)),
  };
}

export function electronRuntimeContract(identity) {
  return {
    electronVersion: identity.electronVersion,
    platform: identity.platform,
    arch: identity.arch,
    packageRoot: identity.packageRoot,
    sourceExecutable: identity.sourceExecutable,
    preparedExecutable: identity.preparedExecutable,
    preparedRuntimeDirectory: identity.preparedRuntimeDirectory,
  };
}
