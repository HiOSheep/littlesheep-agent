// Small deterministic Monarch providers for languages Monaco does not bundle.

import type * as Monaco from 'monaco-editor'
import { LS_CUSTOM_LANGUAGE_IDS } from '../../shared/workspace-languages'

const configuredMonaco = new WeakSet<object>()

export function configureLittleSheepMonaco(monaco: typeof Monaco): void {
  if (configuredMonaco.has(monaco)) return
  configuredMonaco.add(monaco)

  for (const languageId of LS_CUSTOM_LANGUAGE_IDS) {
    if (!monaco.languages.getLanguages().some((language) => language.id === languageId)) {
      monaco.languages.register({ id: languageId })
    }
    monaco.languages.setMonarchTokensProvider(languageId, createTokenizer(languageId))
  }
}

function createTokenizer(languageId: string): Monaco.languages.IMonarchLanguage {
  const keywords = KEYWORDS[languageId] ?? COMMON_KEYWORDS
  const lineComment = languageId === 'haskell' || languageId === 'erlang'
    ? '--'
    : languageId === 'latex'
      ? '%'
      : '#'
  return {
    defaultToken: '',
    tokenPostfix: `.${languageId}`,
    keywords,
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
    ],
    tokenizer: {
      root: [
        [/[ \t\r\n]+/, 'white'],
        [new RegExp(`${escapeRegExp(lineComment)}.*$`), 'comment'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, { token: 'comment', next: '@comment' }],
        [/[a-zA-Z_$][\w$-]*/, {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],
        [/[{}()[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/[=:+*\-!?<>/&|%^~]+/, 'operator'],
        [/[0-9]+(\.[0-9]+)?([eE][\-+]?[0-9]+)?/, 'number'],
        [/["']/,'string', '@string'],
      ],
      comment: [
        [/[^*/]+/, 'comment'],
        [/\/\*/, 'comment', '@push'],
        [/\*\//, 'comment', '@pop'],
        [/[/ *]/, 'comment'],
      ],
      string: [
        [/\\./, 'string.escape'],
        [/[^\\"']+/, 'string'],
        [/["]/, 'string', '@pop'],
        [/[']/, 'string', '@pop'],
      ],
    },
  }
}

const COMMON_KEYWORDS = [
  'class', 'def', 'do', 'else', 'end', 'for', 'fn', 'function', 'if', 'import',
  'in', 'let', 'match', 'module', 'namespace', 'new', 'return', 'struct', 'then',
  'trait', 'type', 'use', 'val', 'var', 'when', 'where', 'while', 'with',
]

const KEYWORDS: Record<string, string[]> = {
  assembly: ['section', 'global', 'extern', 'mov', 'push', 'pop', 'call', 'ret', 'jmp'],
  erlang: ['after', 'begin', 'case', 'catch', 'cond', 'end', 'fun', 'if', 'let', 'of', 'receive', 'try'],
  groovy: ['as', 'assert', 'def', 'in', 'interface', 'trait', 'throws', 'println'],
  haskell: ['case', 'data', 'deriving', 'do', 'else', 'forall', 'if', 'import', 'in', 'instance', 'let', 'module', 'of', 'then', 'type', 'where'],
  latex: ['begin', 'documentclass', 'end', 'frac', 'include', 'newcommand', 'section', 'text', 'usepackage'],
  nim: ['addr', 'and', 'block', 'case', 'const', 'converter', 'defer', 'distinct', 'echo', 'else', 'except', 'for', 'if', 'import', 'in', 'let', 'of', 'proc', 'return', 'type', 'var', 'when', 'while'],
  nix: ['assert', 'rec', 'if', 'else', 'in', 'inherit', 'let', 'with'],
  ocaml: ['and', 'as', 'begin', 'class', 'constraint', 'end', 'external', 'fun', 'function', 'if', 'in', 'include', 'inherit', 'let', 'match', 'method', 'module', 'mutable', 'object', 'of', 'open', 'rec', 'then', 'type', 'val', 'virtual', 'when', 'with'],
  prisma: ['datasource', 'generator', 'model', 'enum', 'type', 'relation', 'true', 'false'],
  toml: ['true', 'false', 'datetime'],
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\[\]\\]/gu, '\\$&')
}
