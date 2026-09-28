// Types for `window-chrome-contract.mjs`, which is the gate's implementation and is
// read from two places: this directory's `.mjs` callers (untyped) and the renderer
// suite, which type-checks. Keep this file in step with the implementation — it is a
// declaration of that module, not a second copy of the gate.
export type WindowChromeContractSourceKey =
  | 'stylesManifest'
  | 'rendererRoot'
  | 'windowLayout'
  | 'globalTitlebar'
  | 'appView'
  | 'nativeTitlebar'
  | 'desktopWindowChrome'

export interface WindowChromeContractSources {
  /** The renderer stylesheet, concatenated in the order its `@import` manifest declares. */
  styles: string
  windowLayout: string
  globalTitlebar: string
  appView: string
  nativeTitlebar: string
  desktopWindowChrome: string
}

export interface WindowChromeRuleScope {
  selector: string
  body: string
  /** True when the rule only exists inside an at-rule. */
  nested: boolean
}

export declare const WINDOW_CHROME_REPO_ROOT: string
export declare const WINDOW_CHROME_CONTRACT_SOURCES: Record<WindowChromeContractSourceKey, string>
export declare function loadWindowChromeContractSources(repoRoot?: string): Promise<WindowChromeContractSources>
export declare function ruleScopes(source: string): WindowChromeRuleScope[]
export declare function ruleBody(source: string, selector: string): string | null
export declare function ruleDeclarations(body: string): Map<string, string>
export declare function evaluateLength(value: string, properties: Map<string, string>): number
export declare function windowChromeContractViolations(sources: WindowChromeContractSources): string[]