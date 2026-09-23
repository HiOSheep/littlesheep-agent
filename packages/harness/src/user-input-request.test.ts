// The model's question crosses from the tools package into the harness, so the
// shape it must satisfy is pinned here: a bounded field, one prompt, required and
// up to six options, and nothing that does not fit is accepted.
import { describe, expect, it } from 'vitest';
import {
  evaluateUserInputRequestRound,
  USER_INPUT_REQUEST_TOOL_NAME,
  parseUserInputRequest,
} from './user-input-request.js';

describe('parseUserInputRequest', () => {
  it('accepts a bounded question and defaults required to true', () => {
    expect(parseUserInputRequest({ field: 'targetFile', prompt: '哪个文件？' })).toEqual({
      field: 'targetFile',
      prompt: '哪个文件？',
      required: true,
    });
  });

  it('keeps up to six options and drops an empty option list', () => {
    expect(parseUserInputRequest({
      field: 'scope',
      prompt: '范围？',
      required: false,
      options: ['仅本文件', '整个目录'],
    })).toEqual({
      field: 'scope',
      prompt: '范围？',
      required: false,
      options: ['仅本文件', '整个目录'],
    });
    expect(parseUserInputRequest({ field: 'scope', prompt: '范围？', options: [] }))
      .toEqual({ field: 'scope', prompt: '范围？', required: true });
  });

  it('rejects anything that does not fit the contract', () => {
    expect(parseUserInputRequest(undefined)).toBeNull();
    expect(parseUserInputRequest('ask something')).toBeNull();
    expect(parseUserInputRequest({ prompt: '缺少 field' })).toBeNull();
    expect(parseUserInputRequest({ field: 'x', prompt: '' })).toBeNull();
    expect(parseUserInputRequest({
      field: 'x',
      prompt: 'p',
      options: ['1', '2', '3', '4', '5', '6', '7'],
    })).toBeNull();
  });

  it('pins the tool name the harness looks for', () => {
    // Must match packages/tools/src/builtin/request_user_input.ts. The harness
    // does not import the tools package, so this literal is the contract between
    // the tool the model calls and the branch that recognises it.
    expect(USER_INPUT_REQUEST_TOOL_NAME).toBe('request_user_input');
  });
});

// CE-10: which round shapes are a question, which are an error, and which are a
// question that has to drop the calls beside it.
describe('evaluateUserInputRequestRound', () => {
  const question = (input: unknown = { field: 'target', prompt: '哪个？' }) => ({
    name: USER_INPUT_REQUEST_TOOL_NAME,
    input,
  });

  it('reports an ordinary tool round as no question', () => {
    expect(evaluateUserInputRequestRound([{ name: 'lookup', input: { q: 'x' } }])).toEqual({ kind: 'none' });
    expect(evaluateUserInputRequestRound([])).toEqual({ kind: 'none' });
  });

  it('carries a standalone question', () => {
    expect(evaluateUserInputRequestRound([question()])).toEqual({
      kind: 'request',
      request: { field: 'target', prompt: '哪个？', required: true },
    });
  });

  it('treats a question with other calls as a question, not a protocol error', () => {
    expect(evaluateUserInputRequestRound([
      question(),
      { name: 'lookup', input: { q: 'x' } },
    ])).toEqual({
      kind: 'mixed',
      request: { field: 'target', prompt: '哪个？', required: true },
    });
  });

  it('rejects two questions and a malformed question', () => {
    // Two questions leave the Runtime choosing which one the user answers.
    expect(evaluateUserInputRequestRound([question(), question({ field: 'other', prompt: '还有？' })]))
      .toEqual({ kind: 'invalid', error: expect.stringContaining('standalone tool call') });
    // A question it cannot read is not a question, whether or not other calls
    // share the round.
    expect(evaluateUserInputRequestRound([question({ prompt: '' })]))
      .toEqual({ kind: 'invalid', error: expect.stringContaining('schema validation') });
    expect(evaluateUserInputRequestRound([question({ prompt: '' }), { name: 'lookup', input: {} }]))
      .toEqual({ kind: 'invalid', error: expect.stringContaining('schema validation') });
  });
});
