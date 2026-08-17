// @littlesheep/harness — stages/enter.ts
// ENTER: minimal stage. ctx is already assembled by buildRunContext.
// We just record the entry timestamp and transition to CLASSIFY.

import type { RunContext, StageResult } from '@littlesheep/types';

export async function enterStage(_ctx: RunContext): Promise<StageResult> {
  return {
    stage: 'enter',
    next: 'classify',
    ok: true,
    meta: { enteredAt: new Date().toISOString() },
  };
}
