# Local App API

本目录拥有 Renderer 与桌面验收工具使用的 loopback HTTP/SSE 接口。它是本地应用 API，不是公开网络服务。Main 拥有服务器生命周期、授权、数据访问和 Runner 依赖。

## 契约

- 绑定运行时选择的 loopback 地址，并校验应用客户端使用的实例能力。Renderer projection 不暴露密钥或任意上游 header。
- 路由名和 wire type 由 `packages/app/src/shared` 统一维护；endpoint 按领域放入路由模块，server 文件只组合 router 与资源 owner。
- 请求和响应有大小、超时、取消与脱敏上限；partial 或 truncated 结果必须如实呈现。
- 只依赖元数据、readiness 或安全工作区读取的路由可早于 Runner 恢复响应；run、checkpoint、approval 路由须在 owner 就绪后才开放。
- Runner 与 router 的替换按 generation 隔离；普通 API 请求不应等待完整恢复，也不能读到半初始化 router。
- 文件、Git、终端和浏览器路径都由 Main 复核。HTTP body 中的 workspace path 是请求，不是所有权或批准证明。
- 长连接使用有界队列与 heartbeat。客户端断开不应隐式取消 Main 所有的工作，除非路由契约明确这样规定。

## 路由与证据边界

run/checkpoint、会话与项目、运行设置与 readiness、附件、工作区文件与 review、浏览器、终端、usage、插件和桌面生命周期分别由领域路由负责。只读 projection 不包含 Provider 密钥、完整事件日志或不受限文件正文。

`GET /runtime/usage/daily` 先同步新调用的持久待更新分区，再返回日序列；这只维护派生缓存，不修改权威事件或扫描历史日志。手动刷新／历史回填独立保留。记录异常、执行失败／中断／进行中和无记录是不同事实；顶部异常提示由当前查询区间与筛选的日数据决定。

Git review revision 标识仓库级观察，不代表单个脏文件的原子快照；不稳定读取和截断状态必须可见。

## 验证

Schema 与状态码由 Local App API 定向测试覆盖；跨 Main、Runner 或文件系统的行为还需隔离数据根或 Electron 验收。启动与 readiness、工作区修改与 review 的入口见 [脚本索引](../../../../../scripts/README.md)。
