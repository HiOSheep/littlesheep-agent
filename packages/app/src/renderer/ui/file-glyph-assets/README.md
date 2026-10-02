# 文件格式图标素材

本目录只存放共享 `FileGlyphIcon` 使用的静态 SVG，不包含图标主题插件的运行时代码。Vite 将素材随 Renderer 一起打包，文件图标不请求外部 URL。

18 个 SVG 原样取自 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme/tree/92a9c5b25a5f4ae4c6a475fb99e434caffef5871/icons)，固定版本 `92a9c5b25a5f4ae4c6a475fb99e434caffef5871`。版权与完整 MIT 许可保存在 [LICENSE](LICENSE)，桌面打包通过 `electron-builder.yml` 将该许可复制到 `resources/third-party-licenses/material-icon-theme-LICENSE`。这些是图标主题对格式标志的矢量实现，并非所有格式都存在统一的官方文件图标。

TypeScript、JavaScript、Python、Git、Markdown、HTML、CSS、Rust、Go、Java、C# 保留熟悉的语言或格式标志；JSON 使用括号，YAML 使用结构化文档，Shell 使用终端，配置使用齿轮，锁文件使用锁，数据库使用圆柱，PDF 使用文档符号。未知文件、图片和文件夹的轮廓由共享组件绘制。

使用入口为父目录 `file-glyph-icons.tsx`，仅按文件名归类并引用本地资源；消费者不得根据文件内容或运行状态重新绘制第二套文件图标。更换素材时需要同步版本、来源和许可，并检查 16px 实际文件树及深浅背景下的辨识度。
