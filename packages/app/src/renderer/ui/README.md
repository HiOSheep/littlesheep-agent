# Renderer 通用 UI
最后更新：2026-09-22 12:41:58

这里放跨领域复用的交互基元，而不是具体业务页面。

- `presence.tsx`：淡入淡出、外部点击收回和存在状态。
- `floating-help.tsx`、`overflowing-label.tsx`：延迟提示、定位，以及溢出标签的滚动测量。
- `transient.ts`、`resize.ts`：临时菜单事件和拖动生命周期。
- `icons.tsx`：统一图标集合；`browser-icons.tsx`、`file-glyph-icons.tsx` 是已拆出的浏览器历史和文件类型图标家族。
- `display-frame.ts`、`display-synced-settle.ts`、`use-frame-coalesced-state.ts`：显示帧合并、布局收敛和高频状态合帧。

所有临时浮层应支持点击其他区域收回；新增转场必须使用统一时长、可中断清理和 reduced-motion 兼容路径。

`icons.tsx` 是无状态声明式图标集合，359 行，但不含业务状态、网络调用或跨域依赖；浏览器历史与文件类型两族已经独立成文件，不得再回流合并。
