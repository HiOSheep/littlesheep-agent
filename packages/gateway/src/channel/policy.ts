// @littlesheep/gateway — channel/policy.ts
// Conversation policy evaluation: decides whether an external user is allowed
// to converse with the agent via a channel.
//
// Four policy types (discriminated by `type`):
//   - pairing:   user must present the secret to pair their external id.
//                Once paired, the id is added to an internal allowlist.
//                (Phase 4: pairing state is in-memory; Phase 5+ persists it.)
//   - allowlist: only pre-approved external user ids can talk.
//   - open:      anyone can talk.
//   - disabled:  no one can talk (channel is muted).

import type { ConversationPolicy } from '@littlesheep/config';

/** Result of policy evaluation. */
export interface PolicyResult {
  /** Whether the user is allowed to converse. */
  allowed: boolean;
  /** Human-readable reason (for logging/feedback). */
  reason: string;
}

/**
 * Evaluate a conversation policy for an external user.
 *
 * @param policy The DM or group policy from channel config.
 * @param externalUserId The external user id (e.g. Telegram user.id).
 * @param pairingSecret Optional — the secret presented by the user for pairing.
 *                       Only used when policy.type === 'pairing'.
 * @param pairedIds Optional — set of already-paired external ids (in-memory).
 *                   Only used when policy.type === 'pairing'.
 */
export function evaluatePolicy(
  policy: ConversationPolicy,
  externalUserId: string,
  pairingSecret?: string,
  pairedIds?: Set<string>,
): PolicyResult {
  switch (policy.type) {
    case 'open':
      return { allowed: true, reason: 'policy=open: all users allowed' };

    case 'disabled':
      return { allowed: false, reason: 'policy=disabled: channel muted' };

    case 'allowlist': {
      if (policy.allowedIds.includes(externalUserId)) {
        return { allowed: true, reason: `policy=allowlist: user ${externalUserId} is allowed` };
      }
      return {
        allowed: false,
        reason: `policy=allowlist: user ${externalUserId} not in allowlist (${policy.allowedIds.length} ids)`,
      };
    }

    case 'pairing': {
      // Already paired?
      if (pairedIds?.has(externalUserId)) {
        return { allowed: true, reason: `policy=pairing: user ${externalUserId} already paired` };
      }
      // Presenting the correct secret?
      if (pairingSecret === policy.secret) {
        return { allowed: true, reason: `policy=pairing: user ${externalUserId} paired with secret` };
      }
      return {
        allowed: false,
        reason: `policy=pairing: user ${externalUserId} not paired (present secret to pair)`,
      };
    }

    default: {
      // Exhaustive check — if a new policy type is added, this will error at compile time.
      const _exhaustive: never = policy;
      void _exhaustive;
      return { allowed: false, reason: 'unknown policy type' };
    }
  }
}

/**
 * In-memory pairing state tracker. Tracks which external user ids have
 * successfully paired for each channel.
 *
 * Phase 5+ will persist this to ~/.littlesheep/channels/paired-ids.json.
 */
export class PairingState {
  /** channelId → set of paired external user ids. */
  private state = new Map<string, Set<string>>();

  /** Mark an external user as paired for a channel. */
  pair(channelId: string, externalUserId: string): void {
    let set = this.state.get(channelId);
    if (!set) {
      set = new Set();
      this.state.set(channelId, set);
    }
    set.add(externalUserId);
  }

  /** Check if an external user is paired for a channel. */
  isPaired(channelId: string, externalUserId: string): boolean {
    return this.state.get(channelId)?.has(externalUserId) ?? false;
  }

  /** Get the paired set for a channel (for evaluatePolicy). */
  getPairedIds(channelId: string): Set<string> {
    return this.state.get(channelId) ?? new Set();
  }

  /** Remove all pairing state for a channel (on channel removal). */
  clearChannel(channelId: string): void {
    this.state.delete(channelId);
  }
}
