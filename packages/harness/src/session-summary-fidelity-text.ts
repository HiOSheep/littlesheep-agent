// Defines the Runtime-owned exact-field envelope embedded in probabilistic session summaries.

export const SESSION_SUMMARY_FIDELITY_START = '<!-- littlesheep-session-fidelity:start -->';
export const SESSION_SUMMARY_FIDELITY_END = '<!-- littlesheep-session-fidelity:end -->';

export interface SessionSummaryFidelityField {
  label: string;
  value: string;
}

/** Read exact fields only from the latest complete Runtime fidelity envelope. */
export function readSessionSummaryFidelityFields(
  value: string | undefined,
): SessionSummaryFidelityField[] {
  const section = sessionSummaryFidelitySection(value);
  if (!section) return [];
  return section.split(/\r?\n/gu).flatMap((line) => {
    const match = line.match(/^\s*([^:#\r\n]{1,40})\s*:\s*(\S(?:.*\S)?)\s*$/u);
    return match?.[1] && match[2]
      ? [{ label: match[1], value: match[2] }]
      : [];
  });
}

/** Remove every fidelity envelope before the Runtime appends a rebuilt authoritative block. */
export function stripSessionSummaryFidelitySections(value: string): string {
  let result = value;
  while (true) {
    const start = result.indexOf(SESSION_SUMMARY_FIDELITY_START);
    if (start < 0) return result;
    const end = result.indexOf(
      SESSION_SUMMARY_FIDELITY_END,
      start + SESSION_SUMMARY_FIDELITY_START.length,
    );
    if (end < 0) return result.slice(0, start);
    result = `${result.slice(0, start)}${result.slice(end + SESSION_SUMMARY_FIDELITY_END.length)}`;
  }
}

function sessionSummaryFidelitySection(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const start = value.lastIndexOf(SESSION_SUMMARY_FIDELITY_START);
  if (start < 0) return undefined;
  const end = value.indexOf(
    SESSION_SUMMARY_FIDELITY_END,
    start + SESSION_SUMMARY_FIDELITY_START.length,
  );
  return end < 0
    ? undefined
    : value.slice(start + SESSION_SUMMARY_FIDELITY_START.length, end);
}
