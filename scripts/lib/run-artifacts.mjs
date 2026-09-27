// Where this repository's own tooling writes run artefacts: verification reports, screenshots, ad-hoc
// diagnostics, task manifests.
//
// It deliberately does not live inside the checkout. A repository that accumulates generated caches
// looks dirty to every consumer — `git status`, packaging, and anyone reading the tree — and the rule
// for this project is that no generated cache stays in the working directory. Keeping the artefacts in
// the OS temp area keeps them apart from the sources while still being findable after a run:
//
//   <os temp>/littlesheep-run-artifacts/verification-reports/latest.json
//
// Set LITTLESHEEP_RUN_ARTIFACTS_DIR to put them anywhere else (a CI workspace, for instance). Explicit
// `--dir` / `--json` / `--report` flags on the individual scripts still win over this default.
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const override = process.env['LITTLESHEEP_RUN_ARTIFACTS_DIR']

export const runArtifactsRoot = override
  ? (isAbsolute(override) ? override : resolve(process.cwd(), override))
  : join(tmpdir(), 'littlesheep-run-artifacts')

/** Absolute path inside the run-artefacts root. */
export function runArtifact(...parts) {
  return join(runArtifactsRoot, ...parts)
}
