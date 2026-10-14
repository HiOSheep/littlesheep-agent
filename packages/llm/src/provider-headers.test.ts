import { describe, expect, it } from 'vitest';
import {
  CLIENT_USER_AGENT,
  createProviderSessionId,
  providerRequestHeaders,
} from './provider-headers.js';

const BASE = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  fallbackSessionId: 'littlesheep-fallback',
} as const;

describe('providerRequestHeaders', () => {
  it('keeps the ordinary OpenAI-compatible contract, session-free', () => {
    expect(providerRequestHeaders(BASE, 'conversation-1')).toEqual({
      'Content-Type': 'application/json',
      'User-Agent': CLIENT_USER_AGENT,
      Authorization: 'Bearer sk-test',
    });
  });

  it('routes opencode Go by the conversation it belongs to', () => {
    const headers = providerRequestHeaders(
      { ...BASE, baseURL: 'https://opencode.ai/inference/go/v1' },
      'session-abc',
    );
    expect(headers['x-opencode-session']).toBe('session-abc');
  });

  it('keeps a call without a conversation routable through the client session id', () => {
    const headers = providerRequestHeaders({ ...BASE, baseURL: 'https://opencode.ai/inference/go/v1' });
    expect(headers['x-opencode-session']).toBe('littlesheep-fallback');
  });

  it('matches the gateway on its own subdomains only', () => {
    const subdomain = providerRequestHeaders({ ...BASE, baseURL: 'https://gateway.opencode.ai/v1' });
    expect(subdomain['x-opencode-session']).toBe('littlesheep-fallback');
    const lookalike = providerRequestHeaders({ ...BASE, baseURL: 'https://opencode.ai.example.com/v1' });
    expect(lookalike['x-opencode-session']).toBeUndefined();
  });

  it('lets provider-configured headers win, including their spelling', () => {
    const headers = providerRequestHeaders({
      ...BASE,
      baseURL: 'https://opencode.ai/inference/go/v1',
      configured: { 'user-agent': 'my-gateway-client/9', 'x-opencode-session': 'pinned-session' },
    }, 'session-abc');
    expect(headers['user-agent']).toBe('my-gateway-client/9');
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['x-opencode-session']).toBe('pinned-session');
  });

  it('does not fail a request whose base URL cannot be parsed', () => {
    const headers = providerRequestHeaders({ ...BASE, baseURL: 'not a url' });
    expect(headers['x-opencode-session']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('gives each client a distinct stable fallback id', () => {
    const first = createProviderSessionId();
    expect(first).toMatch(/^littlesheep-/u);
    expect(first).not.toBe(createProviderSessionId());
  });
});
