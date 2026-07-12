---
name: example
description: 展示 LittleSheep 技能文件的 frontmatter 格式。
when_to_use: 需要参考 LittleSheep 技能文件结构时使用。
model: default
---

# 示例技能

这是一个用于展示格式的示例技能。它不会在每轮对话中注入完整正文，只有 frontmatter 中的 `name` 和 `description` 会进入技能索引；Agent 通过 `use_skill` 工具以 `name: "example"` 调用时，正文才会按需加载。

## 这个技能做什么

它不提供实际功能，只用于说明格式：

1. frontmatter 位于两个 `---` 之间。
2. 必填字段为 `name`、`description`、`when_to_use`。
3. 可选字段为 `model`，默认使用当前会话模型。
4. 正文使用 Markdown 编写，并在需要时按需加载。

## 如何编写自己的技能

在 `skills/` 下创建一个与技能同名的目录，再添加 `SKILL.md`：

```text
skills/
└── my-skill/
    └── SKILL.md
```

技能通过 frontmatter 的 `name` 暴露，不使用目录名作为唯一标识。
