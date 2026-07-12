// @littlesheep/harness — override.ts
// Three-layer editability:
//   Layer 1 — full replacement: register a whole new harness by name.
//   Layer 2 — single-stage replacement: harness.registerStage(name, fn).
//   Layer 3 — hook: harness.on({kind, stage, phase, run}).
//
// Layers 2 and 3 live on AgentHarness itself (see default-harness.ts).
// This file provides the Layer 1 registry + a convenience constructor.

import type { AgentHarness, HarnessRegistry } from '@littlesheep/types';
import { createDefaultHarness, type DefaultHarnessOptions } from './default-harness.js';

/** Layer 1 registry: maps names → harnesses, with a default. */
export class HarnessRegistryImpl implements HarnessRegistry {
  private readonly map = new Map<string, AgentHarness>();
  private readonly defaultHarness: AgentHarness;

  constructor(defaultHarness: AgentHarness) {
    this.defaultHarness = defaultHarness;
  }

  /** Layer 1: register a fully custom harness by name (replaces if present). */
  register(name: string, harness: AgentHarness): void {
    this.map.set(name, harness);
  }

  /** Look up a harness by name. Returns undefined if not registered. */
  get(name: string): AgentHarness | undefined {
    return this.map.get(name);
  }

  /** The default Core Flow harness. */
  get default(): AgentHarness {
    return this.defaultHarness;
  }
}

/**
 * Build a registry with a fresh default Core Flow harness built from `opts`.
 * Use this at gateway/cli startup; consumers can register custom harnesses
 * on top (Layer 1) and use harness.registerStage / harness.on for Layers 2/3.
 */
export function createHarnessRegistry(opts: DefaultHarnessOptions): HarnessRegistry {
  const defaultHarness = createDefaultHarness(opts);
  return new HarnessRegistryImpl(defaultHarness);
}
