# 即时性提示契约

设置页里的操作反馈分两类，**行为必须不同**。这条区分是设置页反馈的唯一权威口径。

## 1. 两类反馈

| 类型 | 例子 | 显示方式 | 自动消失 |
| --- | --- | --- | --- |
| **确认**（`success`） | 「已保存供应商 "opencode"。」 | `TransientNoticeToast`：悬浮在页面右下、`position: fixed`、portal 到 `body` | **3 秒** |
| **失败**（`error` / `warning`） | 「读取模型配置失败」「插件操作未完成」「保存失败，内容仍保留在编辑器里」 | `FeedbackNotice`：留在页面流内，原地不动 | **永不** |

**失败绝不自动消失。** 一个 3 秒后自己消失的失败，是用户可能完全错过的失败；而且好几个页面用同一个插槽渲染两类反馈，所以由 `tone` 决定行为，而不是由调用点决定。`useTransientNotice` **只产出 `success`**，测试 `transient-notice-timer.test.ts` 把这条钉住，防止以后有重构把失败悄悄接到自动消失的路径上。

## 2. 为什么是悬浮框

原来的确认是页面流里的一个块（`<div className="storage-settings-notice">`），两个后果：

1. **它常驻。** 只有在下一个操作替换它时才消失，所以一条过期的「已保存」会一直留在屏幕上，比它确认的那个操作活得久。
2. **它占据布局。** 出现和消失会把下面的内容推下去再推回来——仅仅是确认一次保存，就 visibly 移动了它正在确认的那个页面。

所以现在是 `position: fixed` + portal 到 `body`：完全脱离布局。真实窗口验收断言 `contentTop` 在提示出现前、出现时、消失后**都是同一个值**。

## 3. 时间规则

调度逻辑在 `packages/app/src/renderer/ui/transient-notice-timer.ts`，是一个**纯对象**，时钟由外部注入。

之所以把它从 hook 里拆出来：这些规则才是 bug 的所在地，而本仓库的 vitest 跑在 `environment: 'node'` 且没有 DOM 测试库，hook 挂不起来。`use-transient-notice.ts` 只是把它绑到 React state 上。

| 规则 | 不做会怎样 |
| --- | --- |
| 每条 deadline 携带它被创建时的序号 | t=0 的消息在 t=3000 触发时，会清掉 t=2900 才显示的新消息——用户看到新确认闪一下就没了 |
| 重复同一条消息**重启**计时 | 连按两次保存时，第一次的计时在第二次尚未被确认时就到点了 |
| `clear` / `dispose` 先 cancel | 残留的计时会打进下一条消息，或者打进一个已经不存在的组件 |

`transient-notice-timer.test.ts` 覆盖以上每一条。其中「旧 deadline 不能清新消息」这条**经过变异验证**：把序号守卫改成 `if (false) return` 后该测试失败，恢复后通过。（第一版写这条测试时用了完全可靠的 cancel，结果守卫去掉也照样通过——那种测试等于没写。）

## 4. 可访问性

- 悬浮框保留 `role="status"`（`polite`），所以自动消失的确认仍然会被读屏念到。**自动消失是视觉上的便利，播报才是契约。**
- 提示带一个显式的关闭按钮：计时不能是唯一的出路。
- `prefers-reduced-motion: reduce` 时去掉入场动画，但**保留计时**——去掉计时就等于把提示变回常驻。

## 5. 材质

`.transient-toast` 用 `float/menu glass` 配方（`--composer-surface` + `blur(18px) saturate(135%)`），并已登记进 `ui-material-roles.test.ts` 的 `float-glass` 角色。新增玻璃表面必须登记进那张表，否则该测试会失败。

## 6. 验收

```
pnpm run verify:transient-notice-toast
```

在真实 Electron 窗口里断言：提示是 `position: fixed` 且 portal 到 `body`、由**真实保存操作**触发、`role="status"`、不越出视口、出现前/中/后 `contentTop` 不变、~1.2 秒仍在、~3.4 秒已消失。

单元测试：`pnpm exec vitest run packages/app/src/renderer/ui/transient-notice-timer.test.ts`
