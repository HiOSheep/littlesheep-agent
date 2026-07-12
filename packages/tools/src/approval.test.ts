import { describe, it, expect } from 'vitest';
import { checkApproval, DEFAULT_APPROVAL, type ApprovalConfig } from './approval.js';

describe('checkApproval', () => {
  it('blacklist denies (exact prefix)', () => {
    const result = checkApproval('rm -rf /', DEFAULT_APPROVAL);
    expect(result.decision).toBe('denied');
    expect(result.reason).toMatch(/blacklist/);
  });

  it('blacklist denies (format)', () => {
    const result = checkApproval('format C:', DEFAULT_APPROVAL);
    expect(result.decision).toBe('denied');
  });

  it('whitelist approves (git status)', () => {
    const result = checkApproval('git status', DEFAULT_APPROVAL);
    expect(result.decision).toBe('approved');
    expect(result.reason).toMatch(/whitelisted/);
  });

  it('whitelist approves (echo with args)', () => {
    const result = checkApproval('echo hello world', DEFAULT_APPROVAL);
    expect(result.decision).toBe('approved');
  });

  it('whitelist approves (Get-ChildItem)', () => {
    const result = checkApproval('Get-ChildItem -Path .', DEFAULT_APPROVAL);
    expect(result.decision).toBe('approved');
  });

  it('blacklist takes precedence over whitelist', () => {
    const config: ApprovalConfig = {
      whitelist: ['echo'],
      blacklist: ['echo dangerous'],
      approvalMode: 'interactive',
    };
    const result = checkApproval('echo dangerous thing', config);
    expect(result.decision).toBe('denied');
  });

  it('interactive mode escalates unknown commands', () => {
    const result = checkApproval('some-unknown-cmd', DEFAULT_APPROVAL);
    expect(result.decision).toBe('escalate');
    expect(result.reason).toMatch(/interactive/);
  });

  it('auto-approve mode approves unknown commands', () => {
    const config: ApprovalConfig = {
      whitelist: [],
      blacklist: [],
      approvalMode: 'auto-approve',
    };
    expect(checkApproval('anything', config).decision).toBe('approved');
  });

  it('auto-deny mode denies unknown commands', () => {
    const config: ApprovalConfig = {
      whitelist: [],
      blacklist: [],
      approvalMode: 'auto-deny',
    };
    expect(checkApproval('anything', config).decision).toBe('denied');
  });

  it('matching is case-insensitive', () => {
    const result = checkApproval('GIT STATUS', DEFAULT_APPROVAL);
    expect(result.decision).toBe('approved');
  });
});
