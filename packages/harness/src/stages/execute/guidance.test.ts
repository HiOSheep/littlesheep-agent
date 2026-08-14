import { describe, expect, it } from 'vitest'
import type { TaskBook } from '@littlesheep/types'
import { renderStepGuidance } from './guidance.js'

describe('TaskBook step guidance', () => {
  it('pins the model to current-step tools and stops it before later steps', () => {
    const taskBook: TaskBook = {
      goal: 'Translate a PDF.',
      complexity: 'standard',
      successCriteria: ['A translated PDF exists.'],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'Keep the source layout.' },
      steps: [
        {
          id: 'read-source',
          description: 'Read the source PDF.',
          tools: ['inspect_attachment'],
          acceptanceCriteria: ['The source content is available.'],
        },
        {
          id: 'write-output',
          description: 'Create the translated PDF.',
          tools: ['document_create'],
        },
      ],
    }

    const guidance = renderStepGuidance(taskBook, taskBook.steps[0]!, 'read-source', 0, 2, [])

    expect(guidance).toContain('Allowed tools for this step: inspect_attachment')
    expect(guidance).toContain('Tools from earlier or later TaskBook steps are unavailable here')
    expect(guidance).toContain('return the step result immediately')
    expect(guidance).toContain('Do not start a later TaskBook step')
    expect(guidance).not.toContain('Allowed tools for this step: document_create')
  })
})
