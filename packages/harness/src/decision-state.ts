import type {
  ClarificationRequest,
  ClarificationResponse,
  Classification,
  NeedAssessment,
  RunContext,
} from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** Fields owned by the activity-routing, demand and clarification boundary. */
export interface DecisionStateUpdate {
  classification?: Classification;
  needAssessment?: NeedAssessment;
  clarificationRequest?: ClarificationRequest;
  clarificationResponse?: ClarificationResponse;
}

const DECISION_FIELDS = [
  'classification',
  'needAssessment',
  'clarificationRequest',
  'clarificationResponse',
] as const satisfies readonly (keyof DecisionStateUpdate)[];

/**
 * Commit a validated decision-state batch. Validation happens before mutation
 * so a forbidden field cannot leave a partial routing or clarification update.
 */
export function writeDecisionState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: DecisionStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof DecisionStateUpdate>;
  for (const field of fields) {
    if (!DECISION_FIELDS.includes(field)) {
      throw new Error(`Unknown decision state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Replace a clarification request through a copied projection. */
export function updateClarificationRequest(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: (request: ClarificationRequest) => ClarificationRequest,
): ClarificationRequest {
  if (!ctx.clarificationRequest) {
    throw new Error('Cannot update clarification request before one exists.');
  }
  const next = update(structuredClone(ctx.clarificationRequest));
  writeDecisionState(ctx, stage, { clarificationRequest: next });
  return next;
}
