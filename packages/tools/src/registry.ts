// @littlesheep/tools — registry.ts
// Tool registry: register, lookup, list.

import type { AgentTool, ToolRegistration } from '@littlesheep/types';

/** In-memory tool registry. */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  /** Register a tool. Throws if name is taken. */
  register(tool: AgentTool, source: string = 'builtin'): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tools: tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, { tool, source });
  }

  /** Look up a tool by name. */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tools. */
  list(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  /** List tool names only. */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Remove a tool. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Clear all tools. */
  clear(): void {
    this.tools.clear();
  }
}
