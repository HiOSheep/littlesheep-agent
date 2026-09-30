import type * as Monaco from 'monaco-editor'
import {
  LITTLE_SHEEP_SELECTION_BACKGROUND,
  LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE,
  LITTLE_SHEEP_SELECTION_FOREGROUND,
} from '../selection-style'
import { isAppearanceDark, readAppearanceCssColor } from '../app-shell/appearance-preferences'

export const LITTLE_SHEEP_MONACO_THEME = 'littlesheep-midnight'
export const LITTLE_SHEEP_MONACO_LIGHT_THEME = 'littlesheep-daylight'
export const LITTLE_SHEEP_MONACO_CUSTOM_THEME = 'littlesheep-custom'

// Use neutral charcoal surfaces without a blue cast, then reserve saturated
// colour for syntax so code stays vivid against the darker editor.
export const LITTLE_SHEEP_MONACO_THEME_DATA = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'F2F2F2' },
    { token: 'identifier', foreground: 'F2F2F2' },
    { token: 'variable', foreground: 'F2F2F2' },
    { token: 'variable.predefined', foreground: 'C77DFF' },
    { token: 'constant', foreground: 'C77DFF' },
    { token: 'number', foreground: '63E66F' },
    { token: 'number.hex', foreground: '63E66F' },
    { token: 'string', foreground: 'FFAD5C' },
    { token: 'string.key.json', foreground: '7DE7FF' },
    { token: 'string.escape', foreground: 'FFD1A3', fontStyle: 'bold' },
    { token: 'regexp', foreground: '63E66F' },
    { token: 'keyword', foreground: 'FF4D64', fontStyle: 'bold' },
    { token: 'keyword.control', foreground: 'FF3B30', fontStyle: 'bold' },
    { token: 'type', foreground: '4DD8FF' },
    { token: 'type.identifier', foreground: '4DD8FF' },
    { token: 'class', foreground: '4DD8FF' },
    { token: 'constructor', foreground: '4DD8FF' },
    { token: 'namespace', foreground: '4DD8FF' },
    { token: 'function', foreground: '6FA8FF' },
    { token: 'function.call', foreground: '6FA8FF' },
    { token: 'method', foreground: '6FA8FF' },
    { token: 'tag', foreground: '39D0FF' },
    { token: 'metatag', foreground: 'C77DFF' },
    { token: 'attribute.name', foreground: '7DE7FF' },
    { token: 'attribute.value', foreground: 'FFAD5C' },
    { token: 'key', foreground: '7DE7FF' },
    { token: 'delimiter', foreground: 'D8D8D8' },
    { token: 'operator', foreground: 'FFE066' },
    { token: 'annotation', foreground: 'FFD43B' },
    { token: 'comment', foreground: 'A3A3A3', fontStyle: 'italic' },
    { token: 'comment.doc', foreground: 'B5B5B5', fontStyle: 'italic' },
    { token: 'invalid', foreground: 'FF3B30', fontStyle: 'underline' },
  ],
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#F2F2F2',
    'editorGutter.background': '#101010',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#E6E6E6',
    'editorCursor.foreground': '#FFFFFF',
    'editor.selectionBackground': LITTLE_SHEEP_SELECTION_BACKGROUND,
    'editor.inactiveSelectionBackground': LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE,
    'editor.selectionForeground': LITTLE_SHEEP_SELECTION_FOREGROUND,
    'editor.selectionHighlightBackground': '#45454566',
    'editor.wordHighlightBackground': '#55555555',
    'editor.wordHighlightStrongBackground': '#66666666',
    'editor.lineHighlightBackground': '#181818',
    'editor.lineHighlightBorder': '#00000000',
    'editorWhitespace.foreground': '#3A3A3A',
    'editorIndentGuide.background1': '#2D2D2D',
    'editorIndentGuide.activeBackground1': '#686868',
    'editorBracketMatch.background': '#5A5A5A44',
    'editorBracketMatch.border': '#FFD43BAA',
    'editorBracketHighlight.foreground1': '#FFD43B',
    'editorBracketHighlight.foreground2': '#00D4FF',
    'editorBracketHighlight.foreground3': '#B86BFF',
    'editorBracketHighlight.foreground4': '#4CE062',
    'editorBracketHighlight.foreground5': '#FF5A5F',
    'editorBracketHighlight.foreground6': '#4D8DFF',
    'editorBracketHighlight.unexpectedBracket.foreground': '#FF3B30',
    'editor.findMatchBackground': '#8A6500CC',
    'editor.findMatchHighlightBackground': '#66520A66',
    'editor.foldBackground': '#3A3A3A50',
    'editor.rangeHighlightBackground': '#3A3A3A44',
    'editorLink.activeForeground': '#4DD8FF',
    'editorCodeLens.foreground': '#A3A3A3',
    'editorOverviewRuler.border': '#00000000',
    'editorError.foreground': '#FF3B30',
    'editorWarning.foreground': '#FFD43B',
    'editorInfo.foreground': '#4DD8FF',
    'editorHint.foreground': '#63E66F',
    // These 50%-opaque surfaces composite over #101010 to the reference
    // #1A2B1C / #371D17 row tints. Bright accents remain reserved for line
    // numbers, counts, and the continuous left edge.
    'diffEditor.insertedLineBackground': '#23452780',
    'diffEditor.insertedTextBackground': '#00000000',
    'diffEditor.removedLineBackground': '#5D291D80',
    'diffEditor.removedTextBackground': '#00000000',
    'diffEditor.diagonalFill': '#2B2B2B',
    'diffEditor.border': '#303030',
    'diffEditorGutter.insertedLineBackground': '#00000000',
    'diffEditorGutter.removedLineBackground': '#00000000',
    'diffEditorOverview.insertedForeground': '#02A24380',
    'diffEditorOverview.removedForeground': '#DE352E80',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#88888833',
    'scrollbarSlider.hoverBackground': '#99999955',
    'scrollbarSlider.activeBackground': '#B0B0B077',
    'editorWidget.background': '#181818',
    'editorWidget.border': '#3A3A3A',
    'editorHoverWidget.background': '#181818',
    'editorHoverWidget.border': '#3A3A3A',
    'editorSuggestWidget.background': '#181818',
    'editorSuggestWidget.border': '#3A3A3A',
    'editorSuggestWidget.foreground': '#F2F2F2',
    'editorSuggestWidget.selectedBackground': '#303030',
  },
} satisfies Monaco.editor.IStandaloneThemeData

const LIGHT_SYNTAX_COLORS: Record<string, string> = {
  '': '252523', identifier: '252523', variable: '252523',
  'variable.predefined': '7040A0', constant: '7040A0', number: '1C7131', 'number.hex': '1C7131',
  string: '914600', 'string.key.json': '08788A', 'string.escape': '854000', regexp: '1C7131',
  keyword: 'B4232D', 'keyword.control': '9F1C27', type: '087185', 'type.identifier': '087185',
  class: '087185', constructor: '087185', namespace: '087185', function: '245F9B',
  'function.call': '245F9B', method: '245F9B', tag: '087185', metatag: '7040A0',
  'attribute.name': '08788A', 'attribute.value': '914600', key: '08788A', delimiter: '4A4A46',
  operator: '745900', annotation: '745900', comment: '676767', 'comment.doc': '5C5C5C', invalid: 'B4232D',
}
export const LITTLE_SHEEP_MONACO_LIGHT_RULES = LITTLE_SHEEP_MONACO_THEME_DATA.rules.map((rule) => ({
  ...rule,
  foreground: LIGHT_SYNTAX_COLORS[rule.token] ?? rule.foreground,
}))

export function registerLittleSheepMonacoTheme(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(LITTLE_SHEEP_MONACO_THEME, LITTLE_SHEEP_MONACO_THEME_DATA)
  monaco.editor.defineTheme(LITTLE_SHEEP_MONACO_LIGHT_THEME, {
    ...LITTLE_SHEEP_MONACO_THEME_DATA,
    base: 'vs',
    rules: LITTLE_SHEEP_MONACO_LIGHT_RULES,
    colors: {
      ...LITTLE_SHEEP_MONACO_THEME_DATA.colors,
      'editor.background': '#e9e9e7',
      'editor.foreground': '#252523',
      'editorGutter.background': '#e9e9e7',
      'editorLineNumber.foreground': '#73736f',
      'editorLineNumber.activeForeground': '#292927',
      'editorCursor.foreground': '#20201e',
      'editor.selectionBackground': '#bfd1ee',
      'editor.inactiveSelectionBackground': '#d3dce9',
      'editor.selectionForeground': '#171716',
      'editor.selectionHighlightBackground': '#8199bd44',
      'editor.wordHighlightBackground': '#90a6c944',
      'editor.wordHighlightStrongBackground': '#738dbb55',
      'editor.lineHighlightBackground': '#e2e2df',
      'editorWhitespace.foreground': '#b4b4af',
      'editorIndentGuide.background1': '#cececa',
      'editorIndentGuide.activeBackground1': '#92928c',
      'editorSuggestWidget.background': '#fafaf9',
      'editorSuggestWidget.border': '#b8b8b4',
      'editorSuggestWidget.foreground': '#252523',
      'editorSuggestWidget.selectedBackground': '#e0e8f3',
      'editorWidget.background': '#fafaf9',
      'editorWidget.border': '#c4c4c0',
      'editorHoverWidget.background': '#fafaf9',
      'editorHoverWidget.border': '#c4c4c0',
      'diffEditor.insertedLineBackground': '#D8F1DC',
      'diffEditor.removedLineBackground': '#F8DEDA',
      'diffEditor.diagonalFill': '#D7D7D3',
      'diffEditor.border': '#C4C4C0',
    },
  })
  updateLittleSheepMonacoCustomTheme(monaco)
}

export function updateLittleSheepMonacoCustomTheme(monaco: typeof Monaco): void {
  const root = typeof document === 'undefined' ? null : document.documentElement
  const read = (name: string, fallback: string) => root ? readAppearanceCssColor(name, fallback) : fallback
  const background = read('--workspace-code-surface', '#e9e9e7')
  const foreground = read('--text-strong', '#252523')
  monaco.editor.defineTheme(LITTLE_SHEEP_MONACO_CUSTOM_THEME, {
    ...LITTLE_SHEEP_MONACO_THEME_DATA,
    base: isAppearanceDark() ? 'vs-dark' : 'vs',
    rules: isAppearanceDark() ? LITTLE_SHEEP_MONACO_THEME_DATA.rules : LITTLE_SHEEP_MONACO_LIGHT_RULES,
    colors: {
      ...LITTLE_SHEEP_MONACO_THEME_DATA.colors,
      'editor.background': background,
      'editor.foreground': foreground,
      'editorGutter.background': background,
      'editorLineNumber.foreground': read('--muted-2', '#858585'),
      'editorLineNumber.activeForeground': foreground,
      'editorCursor.foreground': foreground,
      'editor.selectionBackground': read('--code-selection-background', '#454545'),
      'editor.inactiveSelectionBackground': read('--code-selection-background-inactive', '#3a3a3a'),
      'editor.selectionForeground': read('--selection-foreground', '#f2f2f2'),
      'editorSuggestWidget.background': read('--surface', background),
      'editorSuggestWidget.border': read('--border-strong', '#474747'),
      'editorSuggestWidget.foreground': foreground,
      'editorWidget.background': read('--surface', background),
      'editorWidget.border': read('--border', '#343434'),
      'editorHoverWidget.background': read('--surface', background),
      'editorHoverWidget.border': read('--border', '#343434'),
      'diffEditor.insertedLineBackground': isAppearanceDark() ? '#23452780' : '#D8F1DC',
      'diffEditor.removedLineBackground': isAppearanceDark() ? '#5D291D80' : '#F8DEDA',
      'diffEditor.diagonalFill': read('--surface-3', isAppearanceDark() ? '#2B2B2B' : '#D7D7D3'),
      'diffEditor.border': read('--border', isAppearanceDark() ? '#303030' : '#C4C4C0'),
    },
  })
}
