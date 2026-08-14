import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from './registry.js';
import { registerBuiltinTools } from './index.js';
import type { AgentTool } from '@littlesheep/types';
import { z } from 'zod';

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}),
    async execute() {
      return { callId: '', ok: true, output: 'ok' };
    },
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers and looks up a tool', () => {
    const tool = makeTool('foo');
    registry.register(tool);
    expect(registry.has('foo')).toBe(true);
    const reg = registry.get('foo');
    expect(reg?.tool).toBe(tool);
    expect(reg?.source).toBe('builtin');
  });

  it('registers with custom source', () => {
    registry.register(makeTool('bar'), 'mcp:server1');
    expect(registry.get('bar')?.source).toBe('mcp:server1');
  });

  it('throws on duplicate name', () => {
    registry.register(makeTool('dup'));
    expect(() => registry.register(makeTool('dup'))).toThrow(/already registered/);
  });

  it('has() returns false for unknown tool', () => {
    expect(registry.has('nope')).toBe(false);
  });

  it('get() returns undefined for unknown tool', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('list() returns all registrations', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    expect(registry.list()).toHaveLength(2);
  });

  it('names() returns tool names', () => {
    registry.register(makeTool('alpha'));
    registry.register(makeTool('beta'));
    expect(registry.names().sort()).toEqual(['alpha', 'beta']);
  });

  it('unregister() removes a tool and returns true', () => {
    registry.register(makeTool('gone'));
    expect(registry.unregister('gone')).toBe(true);
    expect(registry.has('gone')).toBe(false);
  });

  it('unregister() returns false for unknown tool', () => {
    expect(registry.unregister('never')).toBe(false);
  });

  it('clear() empties the registry', () => {
    registry.register(makeTool('x'));
    registry.register(makeTool('y'));
    registry.clear();
    expect(registry.names()).toHaveLength(0);
  });

  it('registers structured document readers and creators as core builtins', () => {
    registerBuiltinTools(registry);
    expect(registry.names()).toEqual(expect.arrayContaining(['document_read', 'document_create']));
  });
});
