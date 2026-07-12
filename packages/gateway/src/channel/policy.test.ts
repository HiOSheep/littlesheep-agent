// @littlesheep/gateway — channel/policy.test.ts
// Tests for evaluatePolicy + PairingState.

import { describe, it, expect } from 'vitest';
import { evaluatePolicy, PairingState } from './policy.js';
import type { ConversationPolicy } from '@littlesheep/config';

describe('evaluatePolicy', () => {
  it('open policy allows everyone', () => {
    const policy: ConversationPolicy = { type: 'open' };
    const result = evaluatePolicy(policy, 'user-1');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('open');
  });

  it('disabled policy blocks everyone', () => {
    const policy: ConversationPolicy = { type: 'disabled' };
    const result = evaluatePolicy(policy, 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('allowlist allows listed users', () => {
    const policy: ConversationPolicy = {
      type: 'allowlist',
      allowedIds: ['user-1', 'user-2'],
    };
    expect(evaluatePolicy(policy, 'user-1').allowed).toBe(true);
    expect(evaluatePolicy(policy, 'user-2').allowed).toBe(true);
  });

  it('allowlist blocks unlisted users', () => {
    const policy: ConversationPolicy = {
      type: 'allowlist',
      allowedIds: ['user-1'],
    };
    const result = evaluatePolicy(policy, 'user-evil');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in allowlist');
  });

  it('allowlist with empty list blocks everyone', () => {
    const policy: ConversationPolicy = {
      type: 'allowlist',
      allowedIds: [],
    };
    expect(evaluatePolicy(policy, 'user-1').allowed).toBe(false);
  });

  it('pairing blocks when no secret presented and not paired', () => {
    const policy: ConversationPolicy = {
      type: 'pairing',
      secret: 'shh-secret',
    };
    const result = evaluatePolicy(policy, 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not paired');
  });

  it('pairing allows when correct secret presented', () => {
    const policy: ConversationPolicy = {
      type: 'pairing',
      secret: 'shh-secret',
    };
    const result = evaluatePolicy(policy, 'user-1', 'shh-secret');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('paired with secret');
  });

  it('pairing blocks when wrong secret presented', () => {
    const policy: ConversationPolicy = {
      type: 'pairing',
      secret: 'shh-secret',
    };
    const result = evaluatePolicy(policy, 'user-1', 'wrong-secret');
    expect(result.allowed).toBe(false);
  });

  it('pairing allows already-paired users (via pairedIds)', () => {
    const policy: ConversationPolicy = {
      type: 'pairing',
      secret: 'shh-secret',
    };
    const pairedIds = new Set(['user-1']);
    const result = evaluatePolicy(policy, 'user-1', undefined, pairedIds);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('already paired');
  });

  it('pairing ignores pairedIds for other users', () => {
    const policy: ConversationPolicy = {
      type: 'pairing',
      secret: 'shh-secret',
    };
    const pairedIds = new Set(['user-1']);
    const result = evaluatePolicy(policy, 'user-2', undefined, pairedIds);
    expect(result.allowed).toBe(false);
  });
});

describe('PairingState', () => {
  it('starts empty — isPaired returns false', () => {
    const state = new PairingState();
    expect(state.isPaired('ch-1', 'user-1')).toBe(false);
  });

  it('pair marks a user as paired', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    expect(state.isPaired('ch-1', 'user-1')).toBe(true);
  });

  it('pair is idempotent', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    state.pair('ch-1', 'user-1');
    expect(state.getPairedIds('ch-1').size).toBe(1);
  });

  it('pairing is per-channel', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    expect(state.isPaired('ch-1', 'user-1')).toBe(true);
    expect(state.isPaired('ch-2', 'user-1')).toBe(false);
  });

  it('getPairedIds returns empty set for unknown channel', () => {
    const state = new PairingState();
    expect(state.getPairedIds('unknown').size).toBe(0);
  });

  it('getPairedIds returns all paired users for a channel', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    state.pair('ch-1', 'user-2');
    state.pair('ch-2', 'user-3');
    const ids = state.getPairedIds('ch-1');
    expect(ids.size).toBe(2);
    expect(Array.from(ids).sort()).toEqual(['user-1', 'user-2']);
  });

  it('clearChannel removes all pairing state for a channel', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    state.pair('ch-1', 'user-2');
    state.pair('ch-2', 'user-3');

    state.clearChannel('ch-1');

    expect(state.isPaired('ch-1', 'user-1')).toBe(false);
    expect(state.isPaired('ch-1', 'user-2')).toBe(false);
    // Other channel untouched.
    expect(state.isPaired('ch-2', 'user-3')).toBe(true);
  });

  it('clearChannel on unknown channel is a no-op', () => {
    const state = new PairingState();
    state.pair('ch-1', 'user-1');
    state.clearChannel('unknown');
    expect(state.isPaired('ch-1', 'user-1')).toBe(true);
  });
});
