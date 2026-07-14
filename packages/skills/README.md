# @littlesheep/skills

加载、调用和创建声明式 Skill，并保持来源和拥有者可追踪。

## 职责与边界

- 公开入口是 `src/index.ts`；加载在 `loader.ts`，调用在 `use_skill.ts`，创建在 `create-skill.ts`。
- Skill 提供可复用说明和流程，不绕过工具权限、Memory Service 或 PluginHost 生命周期。
- 禁止把未信任本地代码伪装成声明式 Skill 执行。

## 依赖与数据

- 仅依赖公共契约和 schema；Runner 与 PluginHost 提供真实拥有者状态。
- 用户 Skill 属于用户数据，插件 Skill 的生命周期由插件拥有者控制。

## 测试与修改定位

- 加载和调用测试与实现同目录。
- 新格式必须保留来源、稳定 ID、启停和移除语义。
