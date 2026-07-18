# LittleSheep 应用图标资源

- `littlesheep-icon.png`：去除背景后的透明源图，供需要高分辨率位图的界面或后续资源处理使用。
- `littlesheep.ico`：包含多个 Windows 尺寸的透明图标，供 Electron 窗口和桌面快捷方式使用。

替换图标时应同时更新这两个文件，并保持透明背景；快捷方式脚本固定读取同目录下的 `.ico` 文件。
