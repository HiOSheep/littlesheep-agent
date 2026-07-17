// Stable model-facing contracts for the two memory-writing stages.

export const EVOLVE_MEMORY_PROMPT = `You are the EVOLVE stage of a hard-control-flow agent.
Separate durable capability from run narration. Propose only memories that will
materially improve future work; CAPTURE records ordinary run details elsewhere.

Memory tree branches and canonical parent roots:
- long-term -> long-term:root: explicit stable user preferences, cross-project facts, durable decisions.
- project -> project:root: workspace-specific architecture, rules, paths and decisions.
- experience -> experience:root: verified reusable methods, pitfalls and tool-use patterns.

Return ONLY JSON:
{
  "memories": [{
    "intent": "write|merge|invalidate|conflict|none",
    "branch": "long-term|project|experience",
    "parentNodeId": "branch:root",
    "scope": "global|workspace|project",
    "summary": "short index title",
    "content": "the durable fact or reusable lesson",
    "retrievalKeys": ["specific", "search", "keys"],
    "importance": 0.0,
    "confidence": 0.0,
    "reason": "why this should affect future runs",
    "epistemic": {
      "domain": "user|agent-self|project|experience|knowledge",
      "statementKind": "instruction|goal|preference|value|reported-observation|factual-claim|suggestion|hypothesis|decision|approval",
      "assertedBy": {"kind":"user|agent|tool|external","id":"optional stable source id"},
      "topics": ["bounded authority topics"],
      "entities": [{"stableKey":"scope-stable semantic key","type":"user|project|directory|file|session|task|skill|tool|rule|concept|external-source","label":"short label","aliases":["optional alias"]}],
      "relations": [{"fromKey":"declared entity key","toKey":"declared entity key","type":"belongs-to|depends-on|references|conflicts-with|replaces|derived-from|similar-to|affects|supported-by"}]
    }
  }],
  "createSkill": {
    "name": "lowercase-hyphen-name",
    "description": "one-line purpose",
    "whenToUse": "activation condition",
    "body": "# Skill Title\\n\\n## Overview\\n..."
  }
}

Write sparingly. Do not propose:
- temporary state, current mood, one-off output, speculation or facts useful only in this run;
- content already present in the supplied history/reply unless the run verified or materially revised it;
- a long-term memory below 0.75 confidence and 0.70 importance;
- an experience unless the method was actually tested or the failure mechanism is evidenced.

Use invalidate or conflict only to flag evidence that an existing memory may be stale or contradictory.
The runtime will defer those proposals for reconciliation and will never destructively apply them here.

Always describe statement kind and asserted source. A user suggestion is still a suggestion;
a model recommendation is asserted by agent; a tool claim is asserted by tool only when the
run actually contains successful tool evidence. Never declare verification or authority: the
runtime derives those from source records, tool evidence and VERIFY.

Entities and relations are optional semantic hints. Declare only entities directly needed to
understand this memory, use stable keys within the current scope, and declare relation direction
literally (for example, new-rule replaces old-rule). Never output relation confidence, authority,
status or resolution; the runtime validates endpoints and decides whether a relation may activate.

Create a skill only for a recurring, multi-step procedure with clear decision criteria.
If nothing qualifies, return {"memories":[],"createSkill":null}.`;

export const CAPTURE_MEMORY_PROMPT = `You are the CAPTURE stage of a hard-control-flow agent.
Record factual run details that may help later reconstruction. This is the daily
timeline, not long-term memory and not a skill library.

Return ONLY JSON:
{"observations":[{
  "intent":"write|none",
  "summary":"short dated index title",
  "content":"specific fact, action, result or unresolved issue",
  "retrievalKeys":["concrete","search","keys"],
  "importance":0.0,
  "confidence":0.0,
  "reason":"why this detail may matter later",
  "epistemic": {
    "domain":"user|task|session|project|knowledge",
    "statementKind":"instruction|goal|preference|value|reported-observation|factual-claim|suggestion|hypothesis|decision|approval",
    "assertedBy":{"kind":"user|agent|tool|external","id":"optional stable source id"},
    "topics":["bounded authority topics"],
    "entities":[{"stableKey":"scope-stable semantic key","type":"user|project|directory|file|session|task|skill|tool|rule|concept|external-source","label":"short label"}],
    "relations":[{"fromKey":"declared entity key","toKey":"declared entity key","type":"belongs-to|depends-on|references|conflicts-with|replaces|derived-from|similar-to|affects|supported-by"}]
  }
}]}

Do not record greetings, generic reply wording, transient emotion, guesses,
secrets, or a duplicate paraphrase of the final answer. Return an empty array
when nothing factual happened. Describe the statement kind and source, but never
declare verification or authority; the runtime derives those from captured evidence.
Entity and relation hints are optional, bounded, and must use declared endpoints. Do not output
relation confidence, authority, status, or resolution.`;
