// UX-28 item 1: every Git read failure gets its own kind and its own next step, instead
// of every failure reading as "not a repository".
import { describe, expect, it } from 'vitest'
import { classifyGitFailure } from './workspace-git-failure'

/** What Git actually prints; these strings are the classification's real input. */
const GIT_MESSAGES = {
  notRepository: 'fatal: not a git repository (or any of the parent directories): .git',
  ownership: 'fatal: detected dubious ownership in repository at \'D:/work\'\n'
    + "To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/work",
  corruptObject: 'error: object file .git/objects/ab/cdef is empty\nfatal: loose object abcdef (stored in .git/objects/ab/cdef) is corrupt',
  corruptIndex: 'fatal: index file corrupt',
  // Measured: writing garbage into .git/index makes git status say this.
  truncatedIndex: 'fatal: .git/index: index file smaller than expected',
  permission: "fatal: cannot open '.git/objects/pack/pack-1.idx': Permission denied",
  timeout: 'Git command timed out.',
  noHead: 'fatal: ambiguous argument \'HEAD\': unknown revision or path not in the working tree.',
}

describe('Git read failure classification', () => {
  it('separates a real non-repository from everything else', () => {
    expect(classifyGitFailure(new Error(GIT_MESSAGES.notRepository)).kind).toBe('not-repository')
  })

  it('recognises the ownership refusal without offering to change global config', () => {
    const failure = classifyGitFailure(new Error(GIT_MESSAGES.ownership))
    expect(failure.kind).toBe('dubious-ownership')
    expect(failure.reason).toContain('safe.directory')
    // The item is explicit: LS must not silently edit the user's global configuration.
    expect(failure.reason).toContain('不会自动改动')
    expect(failure.detail.length).toBeLessThanOrEqual(200)
  })

  it('recognises damaged repository data', () => {
    expect(classifyGitFailure(new Error(GIT_MESSAGES.corruptObject)).kind).toBe('corrupt-repository')
    expect(classifyGitFailure(new Error(GIT_MESSAGES.corruptIndex)).kind).toBe('corrupt-repository')
    expect(classifyGitFailure(new Error(GIT_MESSAGES.truncatedIndex)).kind).toBe('corrupt-repository')
  })

  it('recognises a filesystem refusal', () => {
    expect(classifyGitFailure(new Error(GIT_MESSAGES.permission)).kind).toBe('permission-denied')
  })

  it('separates timeout, cancellation and a missing Git', () => {
    expect(classifyGitFailure(new Error(GIT_MESSAGES.timeout)).kind).toBe('timed-out')
    const abort = new Error('Git command aborted.')
    abort.name = 'AbortError'
    expect(classifyGitFailure(abort).kind).toBe('cancelled')
    const missing = new Error('Git executable was not found in an absolute PATH entry.') as NodeJS.ErrnoException
    missing.code = 'ENOENT'
    expect(classifyGitFailure(missing).kind).toBe('git-unavailable')
  })

  it('does not mistake a repository without commits for a broken one', () => {
    // An unborn HEAD is what a fresh `git init` looks like; it is not a failure the user
    // has to act on, and the classifier must not label it as corruption.
    expect(classifyGitFailure(new Error(GIT_MESSAGES.noHead)).kind).toBe('unknown')
  })

  it('keeps cancellation ahead of any matching text', () => {
    const abort = new Error('fatal: not a git repository (or any of the parent directories): .git')
    abort.name = 'AbortError'
    expect(classifyGitFailure(abort).kind).toBe('cancelled')
  })

  it('reports an unrecognised failure as unknown with bounded raw evidence', () => {
    const failure = classifyGitFailure(new Error('fatal: something new\nmore lines'))
    expect(failure.kind).toBe('unknown')
    expect(failure.detail).toBe('fatal: something new')
    expect(classifyGitFailure(new Error(`${'x'.repeat(400)}`)).detail.length).toBe(200)
    expect(classifyGitFailure(undefined).kind).toBe('unknown')
  })
})
