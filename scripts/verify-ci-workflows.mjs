#!/usr/bin/env node
// Validate that LittleSheep's CI workflows stay hard gates.
//
// Usage:
//   node scripts/verify-ci-workflows.mjs                       # validate this checkout
//   node scripts/verify-ci-workflows.mjs --repo-root=<path>    # validate another checkout
//   node scripts/verify-ci-workflows.mjs --quiet               # only failures
//
// The policy lives in scripts/lib/ci-workflow-policy.mjs. This command is wired
// into the fast workflow (`pnpm run verify:ci-config`) and into the full
// workflow, so weakening `.github/workflows/*.yml` fails CI rather than
// silently reducing coverage.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCiPolicy, formatViolation } from './lib/ci-workflow-policy.mjs'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  return [
    'Validate the GitHub Actions CI policy (hard gates, no silent skips).',
    '',
    'Usage:',
    '  pnpm run verify:ci-config',
    '  node scripts/verify-ci-workflows.mjs [--repo-root=<path>] [--quiet] [--json]',
    '',
    'Options:',
    '  --repo-root=<path>  Repository root to validate (default: this checkout).',
    '  --quiet             Print the summary only; violations are always printed.',
    '  --json              Print the full result as JSON.',
    '  --help              Show this help.',
  ].join('\n')
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { repoRoot: moduleRoot, quiet: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}.`)
      index += 1
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--json') options.json = true
    else if (arg === '--repo-root') options.repoRoot = value()
    else if (arg.startsWith('--repo-root=')) options.repoRoot = arg.slice('--repo-root='.length)
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`)
  }
  if (typeof options.repoRoot !== 'string' || options.repoRoot.trim() === '') {
    throw new Error('--repo-root must not be empty.')
  }
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  const result = await evaluateCiPolicy({ repoRoot: options.repoRoot })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }
  for (const item of result.violations) console.error(formatViolation(item))
  if (result.ok) {
    if (!options.quiet) {
      console.log(
        `[ci-config] ok — ${result.workflowFiles.length}/${result.workflowFiles.length} workflows, `
          + `pnpm@${result.facts.pnpmVersion}, node ${result.facts.nodeVersion}`,
      )
    }
    return 0
  }
  console.error(
    `\nCI config policy: failed (${result.violations.length} violation(s), ${result.workflowFiles.length} workflow file(s) parsed)`,
  )
  return 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`[ci-config] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
