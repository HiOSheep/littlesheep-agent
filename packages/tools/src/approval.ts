// @littlesheep/tools — approval.ts
// exec approval gate: whitelist (auto-approve) + blacklist (auto-reject) + interactive.

import type { ApprovalResult } from '@littlesheep/types';

export interface ApprovalConfig {
  whitelist: string[];
  blacklist: string[];
  approvalMode: 'interactive' | 'auto-approve' | 'auto-deny';
}

/** Default approval config. */
export const DEFAULT_APPROVAL: ApprovalConfig = {
  whitelist: [
    'git status', 'git log', 'git diff', 'git branch',
    'ls', 'dir', 'Get-ChildItem', 'pwd', 'echo',
    'node --version', 'npm --version', 'pnpm --version',
  ],
  blacklist: [
    'rm -rf /', 'format', 'mkfs', 'dd if=', 'shutdown', 'reboot',
  ],
  approvalMode: 'interactive',
};

/** Check if a command matches any pattern in a list (prefix match). */
function matchesAny(cmd: string, patterns: string[]): string | null {
  const lower = cmd.toLowerCase().trim();
  for (const p of patterns) {
    if (lower.startsWith(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Check approval for a command.
 *   1. Blacklist → auto reject
 *   2. Whitelist → auto approve
 *   3. Else → based on approvalMode:
 *      - 'auto-approve' → approve
 *      - 'auto-deny' → deny
 *      - 'interactive' → escalate (caller decides)
 */
export function checkApproval(cmd: string, config: ApprovalConfig): ApprovalResult {
  // 1. Blacklist
  const blacklisted = matchesAny(cmd, config.blacklist);
  if (blacklisted) {
    return { decision: 'denied', reason: `command matches blacklist pattern: "${blacklisted}"` };
  }

  // 2. Whitelist
  const whitelisted = matchesAny(cmd, config.whitelist);
  if (whitelisted) {
    return { decision: 'approved', reason: `whitelisted: "${whitelisted}"` };
  }

  // 3. Mode-based
  switch (config.approvalMode) {
    case 'auto-approve':
      return { decision: 'approved', reason: 'auto-approve mode' };
    case 'auto-deny':
      return { decision: 'denied', reason: 'auto-deny mode' };
    case 'interactive':
      return { decision: 'escalate', reason: 'requires interactive approval' };
  }
}

/** Interactive approval via stdin/stdout (CLI mode). */
export async function interactiveApprove(cmd: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n⚠️  Approve command? [y/N]\n  $ ${cmd}\n> `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}
