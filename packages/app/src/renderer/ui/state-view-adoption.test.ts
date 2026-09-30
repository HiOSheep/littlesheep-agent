import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { VIEW_STATES } from './state-view-specs'

/**
 * The surfaces V3 moved onto the shared four-state view.
 *
 * `states` is what each surface owns, `bespoke` is the markup it used before: the
 * assertions below fail when a page goes back to a hand-rolled empty/unavailable
 * box instead of the shared view (audit finding #20). The list is deliberately a
 * floor, not a ceiling — a new page that adopts `StateView` only has to be added
 * here, and nothing breaks if it is not.
 */
const ADOPTED: Array<{ file: string; states: string[]; bespoke: string[] }> = [
  {
    file: 'settings/scheduled.tsx',
    // "This capability is not connected" — the reason is mandatory in the type.
    states: ['unavailable'],
    bespoke: ['settings-module-empty'],
  },
  {
    file: 'settings/plugins.tsx',
    // "The query matched nothing" — neutral, never read as a failure.
    states: ['empty'],
    bespoke: ['settings-module-empty'],
  },
  {
    file: 'ChannelConnections.tsx',
    // Loading and "no channel configured yet" used to share one `.dialog-hint` box.
    states: ['loading', 'empty'],
    bespoke: ['className="dialog-hint"'],
  },
  {
    file: 'MemorySkills.tsx',
    // Loading, genuinely empty and a failed first load used to be one hint line.
    states: ['loading', 'empty', 'failure'],
    bespoke: ['className="dialog-hint"'],
  },
  {
    file: 'ArchiveManager.tsx',
    // The page-level empty area; the two section lines above it are list rows.
    states: ['empty'],
    bespoke: [],
  },
  {
    file: 'workspace/artifacts.tsx',
    // Artifact loading, empty results and failed reads use the same state contract.
    states: ['loading', 'empty', 'failure'],
    bespoke: ['WorkspacePlaceholder'],
  },
]

async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

/** Renderer components outside `ui/` that render the shared state view. */
async function findStateViewConsumers(): Promise<string[]> {
  const root = new URL('../', import.meta.url)
  const consumers: string[] = []
  async function walk(directory: URL, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'ui') continue
        await walk(new URL(`${entry.name}/`, directory), relative)
        continue
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue
      const source = await readFile(new URL(entry.name, directory), 'utf8')
      if (source.includes('<StateView')) consumers.push(relative)
    }
  }
  await walk(root, '')
  return consumers.sort()
}

describe('state view adoption', () => {
  it('gives every one of the four states a real page consumer', () => {
    const covered = new Set(ADOPTED.flatMap((entry) => entry.states))
    for (const state of VIEW_STATES) {
      expect(covered, `no page renders the ${state} state`).toContain(state)
    }
  })

  it('counts the consumers instead of trusting the shared component alone', async () => {
    const consumers = await findStateViewConsumers()
    const expected = ADOPTED.map((entry) => entry.file)
    for (const file of expected) {
      expect(consumers, `${file} no longer renders StateView`).toContain(file)
    }
    expect(consumers.length).toBeGreaterThanOrEqual(expected.length)
  })

  it('renders the state each surface owns', async () => {
    for (const entry of ADOPTED) {
      const source = await readRendererFile(`../${entry.file}`)
      expect(source, `${entry.file} must import the shared view`).toMatch(/from '\.{1,2}\/ui\/state-view'/)
      for (const state of entry.states) {
        expect(source, `${entry.file} must render state="${state}"`).toContain(`state="${state}"`)
      }
    }
    // The unavailable view is the one that cannot be rendered without a reason.
    const scheduled = await readRendererFile('../settings/scheduled.tsx')
    expect(scheduled).toContain('reason="')
  })

  it('keeps the bespoke empty boxes out of the adopted surfaces', async () => {
    for (const entry of ADOPTED) {
      const source = await readRendererFile(`../${entry.file}`)
      for (const marker of entry.bespoke) {
        expect(source, `${entry.file} went back to ${marker}`).not.toContain(marker)
      }
    }
    // The archive keeps its own container class, so it is pinned structurally: the
    // empty area can only be rendered through the shared view.
    const archive = await readRendererFile('../ArchiveManager.tsx')
    expect(archive).toMatch(/archive-empty-state[\s\S]{0,400}<StateView/)
  })
})
