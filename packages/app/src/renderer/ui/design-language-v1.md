# LS Renderer Design Language V1

**Status:** D1 contract for the existing desktop Renderer. This records the current visual system and the agreed D1 decisions; it does not authorize a page redesign or a new component framework.

## Evidence boundary

- **Source fact** means a token, component, or selector found in the Renderer source and imported stylesheets.
- **Runtime fact** means a value captured from a running Electron Renderer, including computed CSS and a screenshot. A stylesheet declaration by itself does not prove the cascade result.
- **Contract** means a rule to preserve in future work. If the rule differs from current source, the exception is called out and should be fixed only within an authorized scope.

The stylesheet entry point imports the ordered files `styles/00-reset.css` through `styles/23-iconography.css`. `styles/03-shell-sidebar.css` owns the base palette and most shared tokens; `styles/17-appearance-theme.css` adapts semantic roles for light and custom palettes. `app-shell/appearance-preferences.ts` applies the saved theme to the document root before presentation and sets `--ui-font-scale` from the selected interface size.

## Token layers

| Layer | Examples | Contract |
| --- | --- | --- |
| Global foundation | `--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--border`, `--border-strong`, `--accent`, `--danger`, `--success`, `--warning` | These describe roles, not individual pages. Light and custom themes override role values in place. |
| Shared interaction roles | `--feedback-danger-text`, `--feedback-danger-border`, `--danger-control-text`, `--control-height-md`, `--control-height-sm`, `--control-height-row`, `--control-font-size`, `--control-font-size-strong`, `--control-disabled-opacity` | Common medium controls use **34px**; small notice actions use 26px; compact section-row actions use 30px. Regular and strong control text are `calc(12px * var(--ui-font-scale, 1))` and `calc(13px * var(--ui-font-scale, 1))`. Runtime acceptance resolves these through a browser element before comparing them with computed control text. |
| Shape and elevation roles | `--radius-ui`, `--radius-floating-panel`, `--radius-composer`, `--radius-composer-input`, `--radius-card`, `--radius-message-bubble`, `--radius-icon`, `--radius-pill`, `--radius-circle`, `--shadow`, `--shadow-menu`, `--floating-panel-shadow` | Preserve the material’s purpose: controls, floating panels, composer, cards, and message bubbles do not share one universal corner or shadow. |
| Scenario roles | `--chat-*`, `--composer-*`, `--settings-*`, `--sidebar-*`, `--floating-panel-*`, `--scrollbar-*`, `--motion-*` | Keep a scenario token local to its visual responsibility. Do not introduce a second generic token when an existing semantic role applies. |

The current stylesheets define semantic and scenario spacing, such as notice padding, composer padding/gaps, settings row height and chat flow gaps. They do **not** define a universal numbered spacing scale. New work should reuse the nearest existing component role; expanding this into a spacing framework is a separate design decision.

## Color, type, and theme

- The dark base is neutral charcoal (`--bg: #191919`, surfaces from `#242424` through `#333333`), with restrained neutral accents, semantic success/warning/danger colors, and a blue conversation business accent. This is source evidence, not a requirement to make every surface monochrome.
- Theme-specific values belong behind the existing semantic variables. The light theme changes surface, text, border, feedback, and conversation roles. Custom palettes remap core surface and text roles while preserving the component structure.
- The UI font stack starts with Segoe UI Variable Text and includes Microsoft YaHei UI / Segoe UI / Noto Sans SC fallbacks. Chat has its own readable message and secondary/meta roles. Settings has a page-to-row type scale. The interface-size preference scales the roles that refer to `--ui-font-scale`; fixed diagnostic labels and icon geometry remain locally sized.
- `--feedback-danger-text` is the default for field and persistent error text. Controls on a soft-danger surface use `--danger-control-text`; a solid danger confirmation uses `--bg` foreground over `--danger`, with its hover fill mixed toward `--text` so contrast remains legible in both themes. The final computed text color must match the active theme role.

## Shape, borders, elevation, and materials

- Shared control rounding is `--radius-ui: 10px`; floating panels and composer cards use their own 14px roles; the composer input uses 28px; cards use 18px; message bubbles use 22px; icon chips use 3px; pills and circles use 999px and 50%.
- Context Inspector is a compact diagnostic surface. Its internal refresh control, request selector, notice, source table and timeline use **`--radius-diagnostic: 5px`**. Its outer surface retains its existing 12px local shell corner; the 5px role does not flatten the whole workspace.
- One-pixel borders normally derive from `--border` or `--border-strong`. Floating-panel frames use the dedicated floating-panel border roles. Shadows identify elevation: dialog (`--shadow`), menu/picker (`--shadow-menu`), resting floating card (`--floating-panel-shadow`), and chat/card-specific elevation (`--chat-*`).
- Glass identifies a floating layer. The composer, sidebar and selected workspace overlays keep their current material roles. Messages, code, dense lists, settings canvases and Context Inspector content remain stable reading surfaces. Do not add a second blur layer to an already glass-backed surface.

## Component and state roles

| UI role | Reuse/source | V1 rule |
| --- | --- | --- |
| Loading, empty, unavailable, failure | `ui/state-view.tsx` / `StateView` | Use only states the owning data source can prove; unavailable includes a reason; failure exposes retry only when retry is real. |
| Persistent feedback | `ui/feedback-notice.tsx` / `FeedbackNotice` | Tone selects the semantic color and status icon. Error remains visible until resolved. |
| Transient success | `ui/transient-notice-toast.tsx` / `TransientNoticeToast` | Use the fixed glass toast with status semantics; do not test it as an in-flow page notice. |
| Context menus and split actions | `ui/context-menu.tsx`, `ui/split-button.tsx` | Keep their existing menu surface and selection ownership. Domain components provide choices and callbacks. |
| Icons | `ui/icons.tsx`, `ui/state-icons.tsx`, `ui/file-glyph-icons.tsx` | Prefer shared inline SVG actions and state marks. File-type logos keep their identifying source shape/color; unknown files and folders use shared glyphs. |
| Ordinary, primary and destructive actions | `.close-btn`, `.save-btn`, `.danger-btn` in the existing action consumers | `.close-btn` is the regular secondary action role, `.save-btn` is the accent submit role, and `.danger-btn` is the destructive confirmation role. Keep normal, hover and pressed states with the role stylesheet; a compact scene may override only its documented dimensions and type scale. |
| Buttons, fields, cards, rows | Existing domain markup plus shared CSS role selectors | There is no universal Button/Input/Card framework. Reuse semantic CSS roles and existing primitives; do not wrap every element in new component abstractions for this contract. |

Interaction states are owned by their role and the shared state layer: hover follows the containing material; pressed state is resolved in `styles/13-interaction-states.css`; keyboard focus remains visible, with text fields using their documented surface/focus-within treatment; disabled actions use the owning opacity role; busy is distinguishable from disabled and exposes `aria-busy` where the component supports it; reduced-motion preferences collapse transitions and activity motion. State color is paired with wording or a shape mark rather than used alone.

## D2B feedback and form-state contract

The message role and the container geometry are separate decisions. A domain page may keep its own inset, position or alert-dialog context while the rendered status keeps the same theme-aware semantic color.

| Feedback role | Existing source and consumers | V1 appearance and behavior |
| --- | --- | --- |
| Field-level error | Provider editor `.provider-field-error` and its `aria-invalid` / `aria-describedby` field; other form fields may use their domain error text | Text uses `--feedback-danger-text`; the field keeps its existing invalid border and described-by relationship. Do not turn field text into a full notice box. |
| Form-level feedback | `FeedbackNotice` in the Provider editor, Agent profile compression settings and channel dialog; Provider save failure stays inside the editor | Tone supplies the semantic text/fill/border and the shared icon. Persistent failures keep `role="alert"`; success/info/warning use `role="status"`. Save detail remains disclosed on demand; a busy retry is disabled and marked busy where supported. |
| Page-level feedback | `StateView` in settings, archive, channels and memory areas; `FeedbackNotice` in plugin/channel/workspace/review areas; local notices in storage, browser and development-environment settings; `MemorySkills` warning/error and `.archive-error` | Preserve the owner’s existing spacing and placement. Failure text uses `--feedback-danger-text`; warning uses `--warning`; unavailable uses its existing warning icon/reason. `StateView` distinguishes loading, empty, unavailable and failure rather than collapsing them into one alert. |
| Transient toast | `TransientNoticeToast` for Provider, plugin, channel, settings and storage success paths | Fixed glass surface with status announcement and the active theme’s `--success` text. It stays out of page flow. Existing dismissal timing and action ownership remain unchanged. Errors stay persistent. |
| Dangerous-operation prompt | `DangerConfirmDialog` for irreversible deletion, including optional `.danger-confirm-inuse`; the Permission V2 approval surface has its own D2A action role | The in-use hint uses `--warning` / `--warning-soft`; persistent prompt failures use the shared danger text and border. The destructive action retains `.danger-btn` / `--danger-control-text`. Opening or styling the prompt does not change the decision or confirmation path. |

Semantic feedback colors reuse existing theme roles: info uses `--muted` because the current palette has no separate info token; success uses `--success` and `--success-soft`; warning uses `--warning` and `--warning-soft`; error uses `--feedback-danger-text`, `--feedback-danger-border` and `--danger-soft`. Warning borders mix the existing warning role toward transparency; they do not add another palette token. Error text and error borders remain separate roles so a notice can keep a domain border treatment without changing its readable text color.

Intentional local geometry remains: settings storage notices keep their 12px/14px inset, MemorySkills keeps its paired text/action row, and the toast remains a floating glass panel. The old `.plugin-page-notice` selector has no current JSX consumer in the audited Renderer and is retained; D2B does not remove it. `.plugin-page-error`, `.archive-error`, and storage notices are separate consumers, not duplicate containers, even where they share the same error meaning.

## Intentional exceptions and convergence backlog

- **Intentional density:** Context Inspector uses smaller 10–12px diagnostic typography, narrow table/timeline geometry, and the 5px internal corner role. Do not normalize it to settings or chat density.
- **Intentional material differences:** composer glass, sidebar glass, stable settings/reading surfaces, and chat-specific reading/selection roles remain distinct.
- **Intentional compact controls:** 26px notice actions and 30px compact settings actions are separate roles. A provider-card “编辑” action uses the ordinary `.close-btn` role with `--control-height-row`, `--settings-row-desc-font-size`, and the existing `--settings-control-radius`; its color and interaction states still come from the shared ordinary-control role. The 34px role is the general control height, not a blanket minimum for every icon, row, picker or compact scene action.
- **Intentional semantic accents:** destructive buttons use the control danger role; syntax, diff and file-type colors keep domain meaning.
- **Observed settings notice exception:** `.settings-workspace-body .storage-settings-notice` resolves to 12px block / 14px inline padding, while the shared notice role resolves to 8px / 10px. D1 records this as a local settings role rather than promoting it to a global token; any later convergence is a product decision.
- **Convergence fixed by D1:** the provider field error must resolve to `--feedback-danger-text`; the named 5px diagnostic radius replaces Inspector literals; runtime checks use 34px and resolve scaled fonts through computed CSS.
- **Convergence fixed by D2A:** the provider-card edit action no longer borrows the `.save-btn` primary pressed state; its compact size remains local while its ordinary hover and pressed states follow `.close-btn`.
- **Convergence fixed by D2A:** permission approval actions now resolve regular labels through `--control-font-size` and primary/danger confirmation labels through `--control-font-size-strong`; both use the shared 34px height token while retaining their dedicated interaction role. The permission dialog surface now follows `--surface`; its solid danger confirmation uses theme-resolved foreground/fill roles and a contrast-preserving hover mix.
- **Convergence fixed by D2B:** shared `FeedbackNotice` info/success/warning colors, Provider key-status badges, storage error fill/stripe, MemorySkills borders and the deletion in-use warning now resolve through the existing semantic theme roles. Container geometry and feedback flow are unchanged.
- **Still local / not expanded in D1:** spacing remains semantic rather than a global scale; several domain selectors keep explicit sizes for their measured layout. The stylesheet still contains a `.plugin-page-notice` rule that current plugin JSX no longer renders; success feedback is the shared `TransientNoticeToast`. It is kept out of the live success assertion and can be removed in a scoped cleanup after repository-wide consumers are rechecked.

## Acceptance evidence

- `ui-radius-consistency.test.ts` and `ui-state-consistency.test.ts` protect source-level token use and role declarations.
- `scripts/verify-chat-reading-layout.mjs` covers real-window chat reading and Composer geometry, narrow widths, streaming/failure states, and theme captures.
- `scripts/verify-context-inspector.mjs` seeds isolated synthetic sessions and verifies Inspector empty/overview/detail/partial/active states, chat preservation, privacy boundary, and light/dark captures.
- `scripts/verify-shared-ui-roles.mjs` reads computed style in a real Electron window for provider errors, control sizes/type, focus, disabled/waiting, notices, settings pages and light/dark output. Its synthetic mounts prove stylesheet cascade only; they are not product walkthroughs.
- The D2B shared-ui role gate also checks real success/error surfaces in both themes and labels synthetic warning/domain-role samples as cascade-only. The deletion in-use warning and MemorySkills warning are not counted as live walkthroughs unless a safe real fixture reaches them.
- A screenshot or computed-style result is marked verified only when that Electron scene was reached and captured in the current run. Static selectors and Vitest do not substitute for Electron evidence.
