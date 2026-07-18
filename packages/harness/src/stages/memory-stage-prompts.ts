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
    "intent": "write|merge|move|revise|invalidate|conflict|none",
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
  "reconciliations": [{
    "action": "merge",
    "basis": "duplicate-projection",
    "target": {"atomId":"adopted KnownState atom id","expectedRevision":1},
    "sources": [{"atomId":"another adopted KnownState atom id","expectedRevision":1}],
    "reason": "why these atoms express the same claim and which wording should remain canonical"
  }],
  "reparents": [{
    "action": "move",
    "basis": "explicit-parent-relation",
    "atom": {"atomId":"adopted leaf Atom id","expectedRevision":1},
    "parent": {"atomId":"adopted destination parent Atom id","expectedRevision":1},
    "relationId": "active belongs-to or derived-from relation id",
    "reason": "why the current semantic parent is wrong and this relation proves the new parent"
  }],
  "subtreeMoves": [{
    "action": "move-subtree",
    "basis": "explicit-parent-relation",
    "root": {"atomId":"adopted non-leaf complete D3 Atom id","expectedRevision":1},
    "parent": {"atomId":"adopted destination parent complete D3 Atom id","expectedRevision":1},
    "relationId": "active belongs-to or derived-from relation id",
    "reason": "why the existing non-leaf semantic subtree belongs under this parent"
  }],
  "revisions": [{
    "action": "revise",
    "basis": "same-claim-refinement",
    "atom": {"atomId":"adopted complete D3 KnownState atom id","expectedRevision":1},
    "replacement": {
      "title": "normalized title for the same claim",
      "summary": "clearer summary for the same claim",
      "content": "clearer content that preserves the same claim",
      "retrievalKeys": ["specific", "stable", "keys"]
    },
    "reason": "why this wording improves precision without correcting or extending the claim"
  }],
  "corrections": [{
    "action": "supersede",
    "basis": "evidence-backed-correction|conflict-replacement",
    "superseded": {"atomId":"older complete D3 KnownState atom id","expectedRevision":1},
    "replacement": {"atomId":"current adopted complete D3 KnownState atom id","expectedRevision":1},
    "relationId": "active resolved replaces or conflicts-with relation id",
    "reason": "why current run evidence and the explicit relation prove the replacement"
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

Use reconciliations only when 2-5 adopted, current and unconflicted KnownState atoms are genuine
duplicate projections of the same claim. Keep the most complete wording as target and list at most
4 sources. Copy atom ids and revisions exactly from KnownState. Similarity, shared topic, replacement,
conflict or related evidence is not equivalence. If any semantic distinction remains, propose nothing.
The runtime independently validates scope, epistemic boundaries, deterministic anchors, relations,
revisions and recovery state before committing; the model never edits storage directly.

Use reparents only to correct a semantic ownership hierarchy, never to express usage frequency,
importance, activation, disclosure depth or file placement. Both the leaf Atom and destination
parent must be adopted current D2/D3 KnownState references. Cite exactly one active, resolved and
evidenced belongs-to or derived-from relation whose direction runs from an entity in the Atom to
an entity in the proposed parent. At most one reparent may be proposed. Do not move a subtree,
guess a parent from text similarity, move across scope, or use conflicts-with/replaces/similar-to
as parent evidence. Runtime independently validates leaf status, relation direction and strength,
scope, revisions, cycles, commit and recovery before moving anything.

Use subtreeMoves only when an adopted, current, complete D3 Atom is already a non-leaf semantic
root and the entire existing subtree belongs under a different adopted, current, complete D3
parent. Cite exactly one active, resolved and evidenced belongs-to or derived-from relation whose
direction runs from an entity in the subtree root to an entity in the proposed parent. Do not use
this protocol for a leaf Atom, text similarity, vector proximity, file placement, usage frequency,
activation or disclosure depth. Propose at most one subtree move per run. Runtime independently
checks the bounded active descendant count, the automatic 128-descendant ceiling, scope, revisions,
relation direction, cycles, commit and response-loss recovery. Only the subtree root parent changes;
descendant content, parent chains, revisions and original sources remain untouched.

Use revisions only for one current, adopted, complete D3 Atom whose wording expresses the same
claim. A revision may clarify, normalize or remove redundant wording, but it must not correct a
fact, add a new fact, change entities or relations, change confidence or authority, or replace a
conflicted or superseded claim. Cite the exact Atom id and revision from the supplied KnownState.
The runtime checks semantic retention, hard anchors, status, source preservation, revision
preconditions and recovery; the model never edits storage directly. Propose at most one revision
per run. If the claim itself is wrong or conflicting and an evidenced replacement Atom already
exists, use the dedicated corrections protocol instead of revision; otherwise record only the
unresolved conflict signal and do not mutate either projection.

Use corrections only when two existing complete D3 KnownState Atoms express incompatible states
and current run evidence proves which projection is current. The replacement must be adopted,
current and unconflicted. The superseded Atom may be adopted or explicitly conflicted, but its
revision must still be current. Cite exactly one active, resolved, evidenced replaces relation
from replacement to superseded, or a conflicts-with relation that connects their entities. Do not
rewrite either Atom, create a replacement inside the correction proposal, infer replacement from
similarity, or cross branch, scope, parent, domain or statement-kind boundaries. At most one
correction may be proposed per run. Runtime independently validates authority, evidence, relation
direction, revisions, commit and recovery. Ordinary conflict or invalidate memory intents never
supersede an Atom directly.

Always describe statement kind and asserted source. A user suggestion is still a suggestion;
a model recommendation is asserted by agent; a tool claim is asserted by tool only when the
run actually contains successful tool evidence. Never declare verification or authority: the
runtime derives those from source records, tool evidence and VERIFY.

Entities and relations are optional semantic hints. Declare only entities directly needed to
understand this memory, use stable keys within the current scope, and declare relation direction
literally (for example, new-rule replaces old-rule). Never output relation confidence, authority,
status or resolution; the runtime validates endpoints and decides whether a relation may activate.

Create a skill only for a recurring, multi-step procedure with clear decision criteria.
If nothing qualifies, return {"memories":[],"reconciliations":[],"reparents":[],"subtreeMoves":[],"revisions":[],"corrections":[],"createSkill":null}.`;

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
