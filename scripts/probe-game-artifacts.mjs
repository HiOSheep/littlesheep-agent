// Mechanical playability probe for generated game artifacts.
//
// Usage: node scripts/probe-game-artifacts.mjs <directory-with-html-games> [--json]
//
// It reports, per file: whether it loads, whether frames advance, whether input
// changes the rendering, a score readout when one can be located, whether a
// restart affordance exists and does something, and every load-time and runtime
// exception. Exit code is 1 when any artifact is `broken`, so it can gate a run
// of the acceptance.
//
// What it cannot decide: whether the game is fun. That stays the human step.
import { probeGameDirectory } from './lib/game-artifact-probe.mjs'

const directory = process.argv[2]
const asJson = process.argv.includes('--json')
if (!directory) {
  console.error('usage: node scripts/probe-game-artifacts.mjs <directory-with-html-games> [--json]')
  process.exit(2)
}

const reports = await probeGameDirectory(directory)
const summary = {
  directory,
  games: reports.length,
  runs: reports.filter((report) => report.verdict === 'runs').length,
  needsALook: reports.filter((report) => report.verdict === 'needs-a-look').length,
  broken: reports.filter((report) => report.verdict === 'broken').length,
}

if (asJson) {
  console.log(JSON.stringify({ summary, reports }, null, 2))
} else {
  for (const report of reports) {
    const detail = report.verdict === 'runs'
      ? `canvas=${report.canvas?.width}x${report.canvas?.height} animates=${report.animates} score=${report.scoreBefore}->${report.scoreAfter} restart=${report.restartAffordance}`
      : [...(report.problems ?? []), ...(report.loadExceptions ?? []).map((error) => `load: ${error}`)].join('; ')
    console.log(`${report.verdict.padEnd(13)} ${report.file.padEnd(20)} ${detail}`)
  }
  console.log(JSON.stringify(summary))
}

process.exit(summary.broken > 0 ? 1 : 0)
