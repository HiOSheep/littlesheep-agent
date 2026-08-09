import {
  assertAppBuildFresh,
  defaultRepoRoot,
  ensureAppBuild,
  invalidateAppBuildManifest,
  recordAppBuildManifest,
} from './lib/app-build-fingerprint.mjs';

const args = new Set(process.argv.slice(2));
const modes = ['--assert', '--build', '--ensure', '--record', '--invalidate'].filter((mode) => args.has(mode));
if (modes.length > 1) throw new Error(`Choose one App build mode, received: ${modes.join(', ')}`);
const mode = modes[0] ?? '--ensure';

let result;
if (mode === '--assert') {
  result = await assertAppBuildFresh(defaultRepoRoot);
} else if (mode === '--build') {
  result = await ensureAppBuild(defaultRepoRoot, { force: true });
} else if (mode === '--record') {
  result = await recordAppBuildManifest(defaultRepoRoot);
} else if (mode === '--invalidate') {
  await invalidateAppBuildManifest(defaultRepoRoot);
  result = { status: 'invalidated' };
} else {
  result = await ensureAppBuild(defaultRepoRoot);
}

console.log(JSON.stringify({
  check: 'app-build-freshness',
  mode: mode.slice(2),
  ok: true,
  status: result.status ?? 'fresh',
  inputDigest: result.input?.digest ?? result.manifest?.input?.digest ?? null,
  outputDigest: result.output?.digest ?? result.manifest?.output?.digest ?? null,
  electronVersion: result.runtime?.electronVersion ?? result.manifest?.runtime?.electronVersion ?? null,
}, null, 2));
