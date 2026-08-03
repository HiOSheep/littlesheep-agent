// Preserves exact user-provided label/value facts across probabilistic session summaries.

import {
  continuityLabeledValues,
  readSessionSummaryFidelityFields,
  SESSION_SUMMARY_FIDELITY_END,
  SESSION_SUMMARY_FIDELITY_START,
  stripSessionSummaryFidelitySections,
} from '@littlesheep/harness';
import type { CompactionSummary, Message } from '@littlesheep/types';

const MAX_FIDELITY_FIELDS = 24;

export interface SessionSummaryFidelityInput {
  llmSummary: string;
  previousSummary?: CompactionSummary;
  coveredMessages: readonly Message[];
  messages: readonly Message[];
}

/** Append a bounded Runtime-owned field block after the model-authored semantic summary. */
export function preserveSessionSummaryFidelity(input: SessionSummaryFidelityInput): string {
  const fields = new Map<string, { label: string; value: string }>();
  const previousFields = readSessionSummaryFidelityFields(input.previousSummary?.summary);
  for (const field of previousFields) rememberField(fields, field);

  // Legacy summaries have no Runtime envelope. Bootstrap them once from the
  // immutable transcript; subsequent compactions only process the new range.
  const sourceMessages = previousFields.length > 0
    ? input.messages
    : input.coveredMessages;
  for (const message of sourceMessages) {
    if (message.role !== 'user') continue;
    const text = messageText(message);
    const assignments = continuityLabeledValues(text);
    const explicitMemoryAssignment = asksToRememberConcreteValues(text);
    for (const field of assignments) {
      if (!explicitMemoryAssignment && !fields.has(fieldKey(field.label))) continue;
      rememberField(fields, field);
    }
  }

  const modelSummary = stripSessionSummaryFidelitySections(input.llmSummary).trim();
  const retained = [...fields.values()].slice(-MAX_FIDELITY_FIELDS);
  if (retained.length === 0) return modelSummary;
  return [
    modelSummary,
    SESSION_SUMMARY_FIDELITY_START,
    '# Runtime-preserved exact fields',
    'These user-provided label/value pairs are authoritative for exact recall:',
    ...retained.map((field) => `${field.label}: ${field.value}`),
    SESSION_SUMMARY_FIDELITY_END,
  ].filter(Boolean).join('\n\n');
}

export function sessionSummaryFidelityMarkers(): { start: string; end: string } {
  return { start: SESSION_SUMMARY_FIDELITY_START, end: SESSION_SUMMARY_FIDELITY_END };
}

function rememberField(
  fields: Map<string, { label: string; value: string }>,
  field: { label: string; value: string },
): void {
  const key = fieldKey(field.label);
  fields.delete(key);
  fields.set(key, { label: field.label, value: field.value });
  while (fields.size > MAX_FIDELITY_FIELDS) {
    const oldest = fields.keys().next().value as string | undefined;
    if (!oldest) break;
    fields.delete(oldest);
  }
}

function fieldKey(label: string): string {
  return label.normalize('NFKC').toLocaleLowerCase('en-US');
}

function asksToRememberConcreteValues(value: string): boolean {
  return /(?:请|帮我|需要你|务必|一定要)?(?:记住|记下|牢记|请保存|保存为|请记录|记录为)|\b(?:remember|memorize|save|store|record)\b/iu.test(value);
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
