import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discoverWorkspaceProjects,
  includeDependents,
  projectsForFiles,
} from '../scripts/workspace-projects.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('development workspace graph', () => {
  it('discovers every maintained package without descending into generated directories', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    expect(projects).toHaveLength(27);
    expect(projects.find((project) => project.name === '@littlesheep/app')?.tsconfigs).toEqual([
      'tsconfig.json',
      'tsconfig.web.json',
    ]);
    expect(projects.find((project) => project.name === '@littlesheep/embedding')?.tsconfigs)
      .toEqual(['tsconfig.json']);
  });

  it('propagates a shared contract change to transitive dependents', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    const changed = projectsForFiles(projects, ['packages/types/src/runtime-contracts.ts']);
    const affected = includeDependents(projects, changed);

    expect(affected).toContain('@littlesheep/types');
    expect(affected).toContain('@littlesheep/harness');
    expect(affected).toContain('@littlesheep/runner');
    expect(affected).toContain('@littlesheep/app');
  });

  it('does not schedule package work for documentation-only changes', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    expect(projectsForFiles(projects, ['docs/decision/project-status.md'])).toEqual(new Set());
  });
});
