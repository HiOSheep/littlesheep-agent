# 文件格式图标素材

本目录只存放共享 `FileGlyphIcon` 使用的静态 SVG，不包含图标主题插件的运行时代码。Vite 将素材随 Renderer 一起打包，文件图标不请求外部 URL。

17 个 SVG 原样取自 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme/tree/92a9c5b25a5f4ae4c6a475fb99e434caffef5871/icons)，固定版本 `92a9c5b25a5f4ae4c6a475fb99e434caffef5871`。版权与完整 MIT 许可保存在 [LICENSE](LICENSE)，桌面打包通过 `electron-builder.yml` 将该许可复制到 `resources/third-party-licenses/material-icon-theme-LICENSE`。这些是图标主题对格式标志的矢量实现，并非所有格式都存在统一的官方文件图标。

`yaml.svg` 是**本目录自行绘制**的一个例外，不属于上游素材：上游那一版是"红笔画的文档"，在 16px 下与 JSON、PDF 等文档类标志难以区分，用户给了 YAML 官方标志作参考后改为"圆角浅色方块 + YAML 字样、A 用标志红 `#cb171e`"（2026-10-03）。它不随上游版本更新，改动时按同样标准（16px 可辨识、深浅背景都可读）复核。

TypeScript、JavaScript、Python、Git、Markdown、HTML、CSS、Rust、Go、Java、C# 保留熟悉的语言或格式标志；JSON 使用括号，YAML 使用官方 YAML 标志，Shell 使用终端，配置使用齿轮，锁文件使用锁（`package-lock.json` 与 `*.lock`；`.yaml`/`.yml` 一律显示 YAML 标志，`pnpm-lock.yaml` 也不例外），数据库使用圆柱，PDF 使用文档符号。未知文件、图片和文件夹的轮廓由共享组件绘制。

使用入口为父目录 `file-glyph-icons.tsx`，仅按文件名归类并引用本地资源；消费者不得根据文件内容或运行状态重新绘制第二套文件图标。更换素材时需要同步版本、来源和许可，并检查 16px 实际文件树及深浅背景下的辨识度。
