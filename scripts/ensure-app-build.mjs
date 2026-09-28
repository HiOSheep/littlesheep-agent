import {
  assertAppBuildFresh,
  defaultRepoRoot,
  ensureAppBuild,
  invalidateAppBuildManifest,
  recordAppBuildManifest,
} from './lib/app-build-fingerprint.mjs';

// Every exit path reports one machine-greppable line, `[app-build] <cause>`, on stderr. The
// launcher shows that line in its failure dialog and refuses to start the previous bundle, so a
// build that cannot run must never be indistinguishable from one that did: the exit code carries
// the verdict, and the named line carries the reason (a missing package manager, a failing
// compiler, or a build that reported success without rewriting its outputs).
function reportFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[app-build] ${message}`);
  // Set the code rather than calling `process.exit`: the named line above is what the launcher
  // reads, and an exit during a pending pipe write can truncate it.
  process.exitCode = 1;
}

let result;
try {
  const args = new Set(process.argv.slice(2));
  const modes = ['--assert', '--build', '--ensure', '--record', '--invalidate'].filter((mode) => args.has(mode));
  if (modes.length > 1) throw new Error(`Choose one App build mode, received: ${modes.join(', ')}`);
  const mode = modes[0] ?? '--ensure';

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
} catch (error) {
  reportFailure(error);
}
