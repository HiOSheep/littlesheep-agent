// @littlesheep/harness — stage-routing-registry.test.ts
// Single-execution-system guard: a routing decision may only name a stage the
// driver actually registers. DECIDE, EVOLVE and CAPTURE were deleted with the
// second execution system and survive only as legacy checkpoint names, so
// returning one of them would end the run with "no stage registered for '<x>'".
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STAGES_DIR = fileURLToPath(new URL('./stages/', import.meta.url));
const DRIVER_SOURCE = new URL('./default-harness.ts', import.meta.url);

/** Every non-test module under `stages/`; route targets live in these files. */
async function routingSources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await routingSources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

describe('stage routing names only registered stages', () => {
  it('never routes to a stage the driver does not register', async () => {
    const [driver, files] = await Promise.all([
      readFile(DRIVER_SOURCE, 'utf8'),
      routingSources(STAGES_DIR),
    ]);
    const registered = new Set(
      [...driver.matchAll(/stages\.set\('([a-z_]+)'/gu)].map((match) => match[1]!),
    );
    expect(registered.size).toBeGreaterThan(0);
    // The retired stages must not reappear as registrations either: their
    // checkpoint names are normalized by resolveCheckpointResumeStage instead.
    expect([...registered]).not.toContain('decide');
    expect([...registered]).not.toContain('evolve');
    expect([...registered]).not.toContain('capture');

    const targets = new Map<string, Set<string>>();
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/next\s*[:=]\s*(?:[^\n]*?\?\s*)?'([a-z_]+)'/gu)) {
        const stage = match[1]!;
        if (stage === 'exit') continue;
        const owners = targets.get(stage) ?? new Set<string>();
        owners.add(file.slice(file.lastIndexOf('stages')));
        targets.set(stage, owners);
      }
    }
    expect(targets.size).toBeGreaterThan(0);

    const unregistered = [...targets]
      .filter(([stage]) => !registered.has(stage))
      .map(([stage, owners]) => `${stage} <- ${[...owners].join(', ')}`);
    expect(unregistered).toEqual([]);
  });
});
