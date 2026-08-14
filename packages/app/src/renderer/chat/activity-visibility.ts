// Progressive disclosure rules for assistant execution activity.
import type { AssistantTurnActivity, LiveStepEvent } from './types'


export function isLiveStepVisible(step: LiveStepEvent): boolean {
  return step.status !== 'pending'
    || step.startedAt !== undefined
    || step.endedAt !== undefined
    || step.toolCount > 0
    || step.activeTools > 0
}


export function visibleActivitySteps(activity: Pick<AssistantTurnActivity, 'steps'>): LiveStepEvent[] {
  return activity.steps.filter(isLiveStepVisible)
}
