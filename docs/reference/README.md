# Reference 文档

## 代码与边界

- [仓库指南](repository-guide.md)：源码定位、package 职责和最少仓库规则。
- [模块拆分地图](module-split-map.md)：当前 300/600 行文件登记及受控超限项，供 check:repo 校验。
- [Core Flow 状态契约](core-flow-state-contract.md)：唯一状态转移 manifest、RunContext 所有权与生命周期。
- [插件开发说明](plugin-development.md)：插件贡献、权限与生命周期。
- [自定义模型供应商](custom-model-providers.md)：Provider 配置和能力语义。

## 安全与发布

- [网络检索安全契约](web-retrieval-security-contract.md)：匿名公共读取与威胁边界。
- [网络检索安全验收](web-retrieval-security-acceptance-2026-08-29.md)：发布阻断项和供应链限制。
- [生产依赖安全记录](production-dependency-security.md)：仍有效的依赖 override 与许可证事项。

## 专项验收基线

- [缓存验收规程](cache-95-acceptance.md)：现行口径和正式验收命令。
- [缓存基线目录](cache-baseline/README.md)：冻结账本及批次索引。
- [桌面冷启动基线](cold-start-baseline/README.md)：冷启动、就绪态与窗口行为的原始验收输入。
