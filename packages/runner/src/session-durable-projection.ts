// Bounded, session-scoped durable projections used by cache-quality reports.
import type {
  DurableModelRequestProjection,
  DurableVerificationProjection,
} from '@littlesheep/types';
import { reduceDurableRunProjection } from '@littlesheep/harness';
import type { DurableEventStore } from './durable-event-store.js';

const MAX_SESSION_RUNS = 64;

export interface SessionDurableProjection {
  readonly modelRequests: readonly DurableModelRequestProjection[];
  readonly verifications: readonly DurableVerificationProjection[];
}

export async function loadSessionDurableProjection(
  eventStore: DurableEventStore,
  sessionId: string,
): Promise<SessionDurableProjection> {
  const runs = (await eventStore.listRuns())
    .filter((run) => run.sessionId === sessionId)
    .slice(-MAX_SESSION_RUNS);
  const modelRequests: DurableModelRequestProjection[] = [];
  const verifications: DurableVerificationProjection[] = [];
  for (const run of runs) {
    const projection = reduceDurableRunProjection(
      await eventStore.read(run.sessionId, run.runId),
    );
    modelRequests.push(...projection.modelRequests);
    verifications.push(...projection.verifications);
  }
  return { modelRequests, verifications };
}
