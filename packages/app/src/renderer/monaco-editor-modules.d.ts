declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/basic-languages/*' {
  import type { languages } from 'monaco-editor'

  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}
