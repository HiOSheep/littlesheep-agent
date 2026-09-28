// Where the workspace build finds its package manager, and how a failure gets named.
//
// Every build in this checkout runs through pnpm, but pnpm is not guaranteed to be on PATH:
// the machines this repository is developed on install it into an npm global prefix that no
// shell profile exports (`prefix=` in the user's `.npmrc`). The build path used to spawn
// `pnpm.cmd` through cmd.exe unconditionally, so a missing package manager arrived as
// `'pnpm.cmd' is not recognized as an internal or external command` on an *inherited* stderr
// stream plus a generic `exit 1` from `defaultBuild()`. Both halves are easy to lose: whoever
// runs the build sees empty captured output and reads it as success, and the error that does
// survive never names the real cause. This module makes the cause the message.
//
// The search order is deliberately boring — an explicit override, then PATH, then the two
// places an `npm i -g pnpm` actually lands (the npm global prefix and pnpm's own install
// directory). Everything it looked at is listed when nothing is found, so the reader can see
// which directory they need to add instead of guessing.
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The environment variable that overrides every other search location. */
export const PNPM_OVERRIDE_ENV = 'LITTLESHEEP_PNPM';

export class PnpmNotFoundError extends Error {
  constructor(message, { searched = [], cause } = {}) {
    super(message);
    this.name = 'PnpmNotFoundError';
    this.code = 'PNPM_NOT_FOUND';
    this.searched = [...searched];
    if (cause) this.cause = cause;
  }
}

function windowsExecutableNames(name) {
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`];
}

function pathEntries(env, platform) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return String(env[key] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter(Boolean);
}

/** `prefix=` from the npm user/global configuration files, in npm's own precedence order. */
export function npmPrefixCandidates({ env = process.env, readFile = defaultReadFileSync } = {}) {
  const candidates = [];
  const configured = env.NPM_CONFIG_PREFIX;
  if (typeof configured === 'string' && configured.trim()) candidates.push({ path: configured.trim(), source: 'NPM_CONFIG_PREFIX' });

  const npmrcFiles = [];
  const explicitUserConfig = env.NPM_CONFIG_USERCONFIG;
  if (typeof explicitUserConfig === 'string' && explicitUserConfig.trim()) npmrcFiles.push(explicitUserConfig.trim());
  const home = env.USERPROFILE || env.HOME;
  if (home) npmrcFiles.push(join(home, '.npmrc'));
  if (env.APPDATA) npmrcFiles.push(join(env.APPDATA, 'npm', 'etc', 'npmrc'));

  for (const file of npmrcFiles) {
    let content;
    try {
      content = readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of String(content).split(/\r?\n/u)) {
      const match = /^\s*prefix\s*=\s*(.+?)\s*$/u.exec(line);
      if (!match) continue;
      const value = match[1].replace(/^"|"$/gu, '');
      if (value) candidates.push({ path: value, source: `${file} prefix=` });
    }
  }
  return candidates;
}

/** Every directory the search visits, in order, with the reason it is there. */
export function pnpmSearchDirectories({ env = process.env, platform = process.platform } = {}) {
  const directories = [];
  const add = (path, source) => {
    if (typeof path !== 'string' || !path.trim()) return;
    const resolved = path.trim();
    if (directories.some((entry) => entry.path.toLowerCase() === resolved.toLowerCase())) return;
    directories.push({ path: resolved, source });
  };

  for (const entry of pathEntries(env, platform)) add(entry, 'PATH');
  add(env.PNPM_HOME, 'PNPM_HOME');
  for (const candidate of npmPrefixCandidates({ env })) add(candidate.path, candidate.source);
  if (env.APPDATA) add(join(env.APPDATA, 'npm'), 'npm global directory');
  if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'pnpm'), 'pnpm install directory');
  if (env.ProgramFiles) add(join(env.ProgramFiles, 'nodejs'), 'Node.js installation');
  add(dirname(process.execPath), 'the running Node.js executable');
  if (platform !== 'win32') add('/usr/local/bin', 'system package directory');
  return directories;
}

function executableNames(platform) {
  return platform === 'win32' ? windowsExecutableNames('pnpm') : ['pnpm'];
}

/**
 * Resolve the pnpm executable.
 *
 * Returns `{ executable, source, searched }`; throws `PnpmNotFoundError` — never a bare
 * `undefined` that a later `spawnSync` would turn into an unrelated ENOENT.
 */
export function resolvePnpmExecutable({
  env = process.env,
  platform = process.platform,
  exists = defaultExistsSync,
} = {}) {
  const override = env[PNPM_OVERRIDE_ENV];
  if (typeof override === 'string' && override.trim()) {
    const candidate = override.trim().replace(/^"|"$/gu, '');
    if (exists(candidate)) return { executable: candidate, source: PNPM_OVERRIDE_ENV, searched: [candidate] };
    throw new PnpmNotFoundError(
      `${PNPM_OVERRIDE_ENV} points at ${candidate}, which does not exist. `
      + `Unset ${PNPM_OVERRIDE_ENV} to search PATH, or point it at the pnpm executable.`,
      { searched: [candidate] },
    );
  }

  const searched = [];
  const names = executableNames(platform);
  for (const directory of pnpmSearchDirectories({ env, platform })) {
    for (const name of names) {
      const candidate = join(directory.path, name);
      searched.push(candidate);
      if (exists(candidate)) return { executable: candidate, source: directory.source, searched };
    }
  }

  throw new PnpmNotFoundError(
    'pnpm was not found, so the workspace build cannot run.\n'
    + `Searched (${searched.length} paths):\n${searched.map((path) => `  ${path}`).join('\n')}\n`
    + `Fix: install pnpm (\`npm install -g pnpm\`), put it on PATH, or set ${PNPM_OVERRIDE_ENV} `
    + 'to the full path of the pnpm executable.',
    { searched },
  );
}

/**
 * The argv that actually runs `executable`.
 *
 * A Windows `.cmd`/`.bat` is not an executable image, so it is started through the command
 * interpreter — with an argv, not a concatenated string, so arguments containing `...`
 * (`--filter @littlesheep/app...`, the dependent filter pnpm itself uses) cannot be re-parsed
 * or mangled by an intermediate shell.
 */
export function pnpmInvocation(executable, args = [], { platform = process.platform, env = process.env } = {}) {
  const displayCommand = [executable, ...args];
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)) {
    const comSpec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return { command: comSpec, args: ['/d', '/s', '/c', executable, ...args], displayCommand };
  }
  return { command: executable, args: [...args], displayCommand };
}

/** `resolvePnpmExecutable` + `pnpmInvocation` in one step. */
export function resolvePnpmInvocation(args = [], options = {}) {
  const { executable, source, searched } = resolvePnpmExecutable(options);
  return { ...pnpmInvocation(executable, args, options), executable, source, searched };
}

/**
 * Describe a finished `spawnSync` result as an error message, or return `null` when the
 * command succeeded.
 *
 * `stdio: 'inherit'` leaves `result.stderr` empty, so the message must stand on its own:
 * it names the command, the exit status and the signal instead of reporting a bare code.
 */
export function pnpmFailureDetail(result, { displayCommand }) {
  const command = displayCommand.join(' ');
  if (result?.error) {
    return `could not start ${command}: ${result.error.message}`;
  }
  if (result?.signal) {
    return `${command} was terminated by ${result.signal}`;
  }
  if (result?.status === 0) return null;
  const status = result?.status ?? 'unknown';
  const captured = [String(result?.stderr ?? '').trim(), String(result?.stdout ?? '').trim()]
    .filter(Boolean)
    .join('\n');
  return captured
    ? `${command} exited with code ${status}:\n${captured}`
    : `${command} exited with code ${status}`;
}
