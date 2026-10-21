// Positive and negative validation of the CI workflow policy.
//
// Positive: the committed workflows, package.json wiring and coverage document
// satisfy scripts/lib/ci-workflow-policy.mjs.
//
// Negative: copies of those files are mutated in a temporary repository to
// weaken a gate, and every mutation must be rejected. This is what makes the
// policy itself testable instead of being a comment that future edits can
// quietly outgrow.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evaluateCiPolicy,
  REQUIRED_RECOVERY_TESTS,
  WORKFLOW_FILES,
} from './lib/ci-workflow-policy.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('./verify-ci-workflows.mjs', import.meta.url))
const fixtures = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ls-ci-policy-'))
  fixtures.push(root)
  await cp(join(repoRoot, '.github', 'workflows'), join(root, '.github', 'workflows'), { recursive: true })
  await cp(join(repoRoot, 'scripts', 'ci'), join(root, 'scripts', 'ci'), { recursive: true })
  await cp(join(repoRoot, 'package.json'), join(root, 'package.json'))
  await mkdir(join(root, 'docs', 'reference'), { recursive: true })
  await cp(join(repoRoot, 'docs', 'reference', 'ci-gates.md'), join(root, 'docs', 'reference', 'ci-gates.md'))
  await cp(join(repoRoot, 'docs', 'reference', 'README.md'), join(root, 'docs', 'reference', 'README.md'))
  return root
}

async function mutateText(root, relativePath, transform) {
  const path = join(root, relativePath)
  const before = await readFile(path, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`Mutation did not change ${relativePath}.`)
  await writeFile(path, after, 'utf8')
}

async function mutatePackageScript(root, scriptName, transform) {
  const path = join(root, 'package.json')
  const document = JSON.parse(await readFile(path, 'utf8'))
  const before = document.scripts[scriptName]
  const after = transform(before)
  if (after === before) throw new Error(`Mutation did not change scripts.${scriptName}.`)
  document.scripts[scriptName] = after
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function addStepAfter(workflowText, afterLine, stepLines) {
  const lines = workflowText.split(/\r?\n/u)
  const index = lines.findIndex((line) => line.includes(afterLine))
  if (index < 0) throw new Error(`Cannot find anchor line: ${afterLine}`)
  lines.splice(index + 1, 0, ...stepLines)
  return lines.join('\n')
}

function removeStep(workflowText, nameLine) {
  const lines = workflowText.split(/\r?\n/u)
  const index = lines.findIndex((line) => line.includes(`name: ${nameLine}`))
  if (index < 0) throw new Error(`Cannot find step: ${nameLine}`)
  // Step blocks are `- name:` followed by indented lines; the dash may be on the
  // same line as the name or on the previous line.
  const dashIndex = lines[index].trimStart().startsWith('- name:') ? index : index - 1
  if (!lines[dashIndex]?.trimStart().startsWith('- name:')) throw new Error(`Unexpected step layout: ${nameLine}`)
  const dashIndent = lines[dashIndex].length - lines[dashIndex].trimStart().length
  let end = index + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') {
      end += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= dashIndent) break
    end += 1
  }
  lines.splice(dashIndex, end - dashIndex)
  return lines.join('\n')
}

function expectViolation(result, code) {
  expect(result.ok, `expected policy failure with ${code}`).toBe(false)
  expect(
    result.violations.map((item) => item.code),
    `violations: ${result.violations.map((item) => item.code).join(', ')}`,
  ).toContain(code)
}

describe('CI workflow policy: positive path', () => {
  it('accepts the committed workflows, package wiring and coverage document', async () => {
    const result = await evaluateCiPolicy({ repoRoot })
    expect(result.violations, result.violations.map((item) => `${item.code}: ${item.message}`).join('\n')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.workflowFiles).toEqual([...WORKFLOW_FILES])
    expect(result.facts.pnpmVersion).toBe('11.9.0')
    expect(result.facts.nodeVersion).toBe('26.4.0')
  })

  it('names only files that exist in the checkout as required recovery suites', () => {
    for (const testFile of REQUIRED_RECOVERY_TESTS) {
      expect(existsSync(join(repoRoot, testFile)), `missing required recovery suite: ${testFile}`).toBe(true)
    }
  })

  it('passes through the CLI entry point', () => {
    const result = spawnSync(process.execPath, [cliPath], { cwd: repoRoot, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('[ci-config] ok')
  })
})

describe('CI workflow policy: negative path', () => {
  const cases = [
    {
      name: 'rejects a missing --frozen-lockfile',
      code: 'install-frozen-lockfile',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          text.replace('run: pnpm install --frozen-lockfile', 'run: pnpm install'))
      },
    },
    {
      name: 'rejects continue-on-error on a gate step',
      code: 'no-continue-on-error',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) => text.replace(
          '      - name: Typecheck\n        run: pnpm run typecheck',
          '      - name: Typecheck\n        continue-on-error: true\n        run: pnpm run typecheck',
        ))
      },
    },
    {
      name: 'rejects a removed job timeout',
      code: 'job-timeout',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          text.replace('    timeout-minutes: 30\n', ''))
      },
    },
    {
      name: 'rejects a gate step made conditional',
      code: 'conditional-step',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) => text.replace(
          '      - name: Repository hygiene and documentation navigation\n        run: pnpm run check:repo',
          "      - name: Repository hygiene and documentation navigation\n        if: env.CI_SKIP_GATES != '1'\n        run: pnpm run check:repo",
        ))
      },
    },
    {
      name: 'rejects a conditional job',
      code: 'conditional-job',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) => text.replace(
          '    timeout-minutes: 90\n',
          "    timeout-minutes: 90\n    if: github.event_name == 'push'\n",
        ))
      },
    },
    {
      name: 'rejects a live-provider command',
      code: 'no-live-provider',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) => addStepAfter(
          text,
          'run: pnpm run test:core-eval',
          ['      - name: Provider smoke', '        run: pnpm run s3b-eval --run-real --authorize-live'],
        ))
      },
    },
    {
      name: 'rejects a GUI/Electron verification claim',
      code: 'gui-not-covered',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) => addStepAfter(
          text,
          'run: pnpm run assert:app-build',
          ['      - name: Electron GUI continuity', '        run: pnpm run verify:electron-ui-state-continuity'],
        ))
      },
    },
    {
      name: 'rejects a GUI coverage claim removed from the document',
      code: 'gui-not-covered-doc',
      async mutate(root) {
        await mutateText(root, 'docs/reference/ci-gates.md', (text) =>
          text.replace('<!-- ci-gates:electron-gui-not-covered -->', '<!-- electron gui is covered by CI -->'))
      },
    },
    {
      name: 'rejects a missing artifact retention policy',
      code: 'artifact-retention',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) =>
          text.replace('          retention-days: 14\n', ''))
      },
    },
    {
      name: 'rejects an artifact upload that can hide a missing report',
      code: 'artifact-missing-report',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) =>
          text.replace('          if-no-files-found: error', '          if-no-files-found: warn'))
      },
    },
    {
      name: 'rejects a pnpm version mismatch with package.json',
      code: 'pnpm-version',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          text.replace('          version: 11.9.0', '          version: 11.8.0'))
      },
    },
    {
      name: 'rejects a Node.js major not verified locally',
      code: 'node-version',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          text.replace("          node-version: '26.4.0'", "          node-version: '22.0.0'"))
      },
    },
    {
      name: 'rejects a removed required gate step',
      code: 'required-step',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          removeStep(text, 'Repository hygiene and documentation navigation'))
      },
    },
    {
      name: 'rejects a removed synthetic data-root bootstrap',
      code: 'data-root-bootstrap',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) =>
          removeStep(text, 'Bootstrap isolated synthetic data root'))
      },
    },
    {
      name: 'rejects a recovery suite dropped from test:ci-recovery',
      code: 'recovery-suite',
      async mutate(root) {
        await mutatePackageScript(root, 'test:ci-recovery', (script) =>
          script.replace('packages/runner/src/durable-run-recovery.test.ts ', ''))
      },
    },
    {
      name: 'rejects secrets-derived provider credentials',
      code: 'no-secrets',
      async mutate(root) {
        const secretLine = '          DEEPSEEK_API_KEY: $' + '{{ secrets.DEEPSEEK_API_KEY }}'
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) => text.replace(
          '      - name: Typecheck\n        run: pnpm run typecheck',
          ['      - name: Typecheck', '        env:', secretLine, '        run: pnpm run typecheck'].join('\n'),
        ))
      },
    },
    {
      name: 'rejects a workflow that drops least-privilege permissions',
      code: 'workflow-permissions',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
          text.replace('permissions:\n  contents: read\n\n', ''))
      },
    },
    {
      name: 'rejects a host-specific WSL platform acceptance in CI',
      code: 'platform-acceptance-not-covered',
      async mutate(root) {
        await mutateText(root, '.github/workflows/ci-full.yml', (text) => addStepAfter(
          text,
          'run: pnpm run assert:app-build',
          ['      - name: WSL terminal acceptance', '        run: pnpm run verify:wsl-terminal'],
        ))
      },
    },
    {
      name: 'rejects a coverage document that drops the platform exclusion marker',
      code: 'platform-exclusions-doc',
      async mutate(root) {
        await mutateText(root, 'docs/reference/ci-gates.md', (text) =>
          text.replace('<!-- ci-gates:platform-exclusions -->', '<!-- platform exclusions covered -->'))
      },
    },
    {
      name: 'rejects an extra unreviewed workflow file',
      code: 'unexpected-workflow',
      async mutate(root) {
        const source = join(root, '.github', 'workflows', 'ci-fast.yml')
        await cp(source, join(root, '.github', 'workflows', 'ci-extra.yml'))
      },
    },
  ]

  it.each(cases)('$name', async ({ mutate, code }) => {
    const root = await makeFixture()
    await mutate(root)
    const result = await evaluateCiPolicy({ repoRoot: root })
    expectViolation(result, code)
  })

  it('fails through the CLI on a mutated repository copy', async () => {
    const root = await makeFixture()
    await mutateText(root, '.github/workflows/ci-fast.yml', (text) =>
      text.replace('run: pnpm install --frozen-lockfile', 'run: pnpm install'))
    const result = spawnSync(process.execPath, [cliPath, `--repo-root=${root}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('install-frozen-lockfile')
  })
})
