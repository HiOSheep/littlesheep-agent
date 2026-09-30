# Shared Renderer UI

This area owns reusable visual roles, focus primitives, icons, notices, state views and interaction tokens. Domain components should consume these primitives instead of creating another local style system.

## 材质角色与分层（V1）

Glass identifies a floating surface. Long reading surfaces, code and dense settings remain on stable opaque surfaces. Keep the established rounded, translucent visual language; use one blur layer per visual surface and shared tokens for fill, border, shadow and radius.

| Role | Use |
| --- | --- |
| Floating panel | Sidebar and workspace surfaces that sit above the application canvas. |
| Composer and menu | Input surface, floating task strip, pickers and action menus. |
| Workspace tab | A lighter glass layer for the active tab above the chat column. |
| Scrim | Darkens the background behind a modal; it is not a content surface. |
| Stable surface | Messages, code, settings canvas, lists and other dense reading areas. |

The visual source lives in Renderer styles. The material-role test inventories backdrop-filter declarations so a new blur surface must have an explicit role.

## 状态矩阵（V3）

| State | Required behavior |
| --- | --- |
| Hover / pressed | Shared role tokens distinguish pointer-over and active press. |
| Focus | Keyboard focus remains visible on native and ARIA interactive roles. |
| Disabled | Use semantic disabled state, default cursor and the owning role opacity. |
| Busy | Expose aria-busy and a visible progress cue where the action takes time. |
| Reduced motion | Honor the system preference for transitions and spinner animation. |

State colors are not the only distinction: shape and text identify status. Prefer shared StateView for loading, empty, unavailable and failure. Unavailable requires a visible reason; failure can expose a retry only when retry is real. Empty means a successful result with no entries.

Focus ownership, destructive confirmation, split buttons, feedback notices, state view and icons are shared primitives. Their source-level behavior is covered by ui tests; real Electron checks are required for hit targets, window chrome, DPI and computed visual output.

Current state-view consumers include the scheduled page (unavailable), plugins and channels (loading / empty), archived items and workspace artifacts (loading / empty / failure), skills, and daily Token usage. Each caller supplies only states it can prove from its own data source.
