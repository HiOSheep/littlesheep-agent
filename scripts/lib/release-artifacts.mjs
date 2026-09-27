// Where this repository's Windows release package is written and read back from.
//
// The same rule as `run-artifacts.mjs`, for the same reason: a release package is a generated
// artefact of roughly a gigabyte, and a checkout that carries one cannot be read as a checkout.
// Production dependencies are copied into `app.asar`, so the payload is a build product, not a
// source file, and it lives in the OS temp area by default:
//
//   <os temp>/littlesheep-run-artifacts/windows-release/win-unpacked/LittleSheep.exe
//
// Set `LITTLESHEEP_RELEASE_DIR` to put it anywhere else (a CI workspace or a dedicated drive).
// A relative value resolves against the current working directory, and the packaged-mode
// verification gates (`--app=packaged` on the `verify:desktop-*` / `measure:desktop-*` entries)
// read the executable through these helpers, so the producer and the consumers cannot drift.
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { runArtifact } from './run-artifacts.mjs'

const override = process.env['LITTLESHEEP_RELEASE_DIR']

/**
 * Absolute root the Windows release is written to. Honours `LITTLESHEEP_RELEASE_DIR`, otherwise
 * shares the run-artefacts root (which itself honours `LITTLESHEEP_RUN_ARTIFACTS_DIR`).
 */
export const releaseRoot = override
  ? (isAbsolute(override) ? override : resolve(process.cwd(), override))
  : runArtifact('windows-release')

/** Absolute path inside the release root. */
export function releaseArtifact(...parts) {
  return join(releaseRoot, ...parts)
}

/** Absolute path of the unpacked application executable produced by `pnpm run package:win`. */
export function packagedExecutablePath() {
  return releaseArtifact('win-unpacked', 'LittleSheep.exe')
}

/** Absolute path of the unpacked application's `resources` directory (holds `app.asar`). */
export function packagedResourcesPath() {
  return releaseArtifact('win-unpacked', 'resources')
}

/**
 * Scratch for one packaging run: the staged `out` tree, the staged Electron runtime and the
 * generated electron-builder config. `mkdtemp` under the OS temp area, never inside the checkout,
 * so an interrupted run leaves nothing behind that `git status` could pick up.
 */
export function releaseScratchRootPrefix() {
  return join(tmpdir(), 'littlesheep-release-packaging-')
}

/** Path of the single-instance packaging lock. Outside the checkout for the same reason. */
export function releaseLockPath() {
  return join(tmpdir(), 'littlesheep-release-packaging.lock')
}
