import { describe, expect, it } from 'vitest';
import { sourceRefEntityType } from './v3-node-mapping.js';

describe('Memory v3 source entity mapping', () => {
  it.each([
    ['user:28971', 'user'],
    ['project:little-sheep', 'project'],
    ['session:conversation-1', 'session'],
    ['task:memory-v3', 'task'],
    ['skill:repository-review', 'skill'],
    ['tool:read', 'tool'],
    ['rule:agents', 'rule'],
    ['concept:progressive-disclosure', 'concept'],
    ['file:D:/workspace/README.md', 'file'],
    ['D:/workspace/package.json', 'file'],
  ] as const)('maps %s to %s', (source, expected) => {
    expect(sourceRefEntityType(source)).toBe(expected);
  });
});
