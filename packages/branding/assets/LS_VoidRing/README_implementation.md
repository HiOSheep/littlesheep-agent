# LS Void Ring 图标与动效实施说明

本交付依据用户提供的母图与专项任务图制作图标与四种动效。母图原文件保存在 `icon/void_ring_reference.png`，与用户附件 SHA256 一致。正式主版直接使用原始母图的球体光照像素，统一调整取景与尺寸，保留黑色球体内侧反射、非对称折射边缘与偏移光冠，不再重新描绘球体。imagegen 的参考编辑曾用于比较球体光照，最终未采用生成候选作为正式主版。此前纯黑圆盘加细边的版本已被替换。P2 成功、错误、悬停状态为可选项，本次未增加。

正式 `icon_master.svg` 是内嵌光照纹理的 SVG，不能声称是纯路径矢量。另交付 `icon_vector_reference.svg` 作为可编辑路径/渐变的近似参考；其视觉精度低于光照母版。任务图中的完整纯路径矢量要求不能据此标记为已完全满足，正式产品显示以光照母版为准。

## 视觉与尺寸契约

- 画布 `1024 × 1024`；球体直径约占画布 61%。流体场中心 `(480,530)`，球体半径参数 `310`；静态图标保持已确认的球面反射。循环动效中黑色实体的形状与位置固定，球面内侧反光、折射亮边与外侧光晕共同流动。
- 静态图标为纯黑 `#000000` 圆角方形，圆角半径为边长的 20%，圆角以外透明。保留上一版产品圆角底板约定。
- 每个尺寸从同一光照母版的 SVG 封装导出，不以均匀加粗的矢量线条覆盖真实折射边缘。32px 保留蓝白光冠与暖色受光轮廓，实际效果见原生尺寸预览。
- 低光版减弱球体外侧的光晕，保留内侧球面反射。球体中心保持近黑，而不是把整个前景填成均匀纯黑。
- 主图标不添加独立亮点、星云、装饰纹理、文字或场景。动效中内圈受光、蓝色光冠、暖色辉光与较暗的左下外晕共同参与流体波动；母版 PNG、SVG 和应用静态图标保持用户已确认的版本。
- 动效 PNG 的外部透明、圆盘本体黑色不透明。透明边缘保留真实 alpha，不以纯黑像素冒充透明。

## 交付文件

| 文件 | 用途 |
| --- | --- |
| `icon/void_ring_reference.png` | 用户原始母图，也是正式球体光照像素来源 |
| `icon/sphere_motion_source.png` | 调整取景后的透明光照层，黑色球体保持不透明 |
| `icon/icon_master.svg` / `.png` | 内嵌球体光照纹理的 SVG 主版与 1024 PNG |
| `icon/icon_vector_reference.svg` | 独立路径/渐变构造的近似矢量参考，不替代正式主版 |
| `icon/void_ring.ico` | Windows 七尺寸图标副本 |
| `icon/icon_low_glow.svg` / `.png` | 低光晕主版 |
| `icon/icon_sizes/` | 标准光晕 1024 / 512 / 256 / 128 / 64 / 32 PNG |
| `icon/icon_sizes_low_glow/` | 低光晕的同一套六尺寸 PNG |
| `motion/void_ring_mark.svg` / `.png` | 透明外部的基础动效图形 |
| `motion/sphere_foreground.png` | 固定的纯黑球体实体遮罩，1024 × 1024；球面受光在动态层中 |
| `motion/illumination_reference.png` / `corona.png` | 包含内侧反光、亮边和外晕的完整光照参考 / 原始外晕参考 |
| `motion/fluid_frames/` | 呼吸 108、加载 60、思考 96 个完整内外光照 PNG 帧，每帧 384 × 384，30fps；覆盖在固定黑色实体之上 |
| `motion/fluid_manifest.json` | 帧率、分辨率、各周期与固定前景资源入口 |
| `motion/motion_spec.png` | 实际 Lottie 播放器导出的透明 4 行 × 8 列帧图，2048 × 1024，每格 256 × 256 |
| `motion/idle_breath.json` | 可直接播放的 Lottie 呼吸动效 |
| `motion/loading_orbit.json` | 可直接播放的 Lottie 加载动效 |
| `motion/thinking_pulse.json` | 可直接播放的 Lottie 思考动效 |
| `motion/open_transition.json` | 可直接播放的 Lottie 展开动效 |
| `motion/*.svg` | 使用全光晕位移滤镜的轻量 SVG 参考，以及一次性展开 SVG |
| `motion/motion-reference.css` | SVG/object 接入、静态降级与减少动态效果的参考 |
| `preview.html` | 可直接打开的本地预览，包括母图、两版主图、实际尺寸与四种 Lottie |
| `preview.gif` | 真实播放器录制的四种动效预览，7.2 秒、30fps 平均帧率 |
| `idle_breath_preview.gif` | 512 × 512 水感呼吸专用预览，3.6 秒、30fps |
| `qa/static_review.png` / `browser_preview.png` | 静态尺寸检查图与真实浏览器截图 |
| `qa/validation.json` | 尺寸、黑底、透明角、ICO、Lottie 播放与循环验证结果 |

帧图的四行依次为呼吸、加载、思考、展开；前三行按周期的 `0/8 … 7/8` 均匀采样，第四行按一次过渡的 `0/7 … 7/7` 采样。该帧图用于检查与索引，不是完整 60fps PNG 序列。

## 四种动效

| 状态 | 时长 | 循环 | 实现 |
| --- | ---: | --- | --- |
| 水感呼吸 | 3600 ms | 是 | 内圈反光随外晕呼吸，整片光晕向四周错相舒展与回落，叠加 2/3/5 阶角向波与径向呼吸，黑色实体固定 |
| 能量环流 | 2000 ms | 是 | 内外光照一起顺时针流动，径向宽度与角向剪切同步变化，柔软波峰随流动推进 |
| 思考潮汐 | 3200 ms | 是 | 内圈反射随蓝色与暖色辉光聚拢、释放，主脉冲叠加二次脉冲，形成错相潮汐 |
| 展开过渡 | 420 ms | 否 | 24% → 100% → 640% 放大并淡出，使用 `cubic-bezier(.22,1,.36,1)` |

JSON 为真实 Lottie 数据：时间轴 `fr=60`，包含 `layers` 与 `assets`。完整内外光照的非刚性形变先按 30fps 烘焙为 384 像素透明 PNG，再以内嵌图片层播放，每个光照帧保持两个时间轴帧；不能将其声称为 60fps 独立形变采样。固定黑色实体仍为 1024 像素，动态光照覆盖其上形成球面反射。展开使用可插值的缩放/透明度关键帧。每份 JSON 自包含，无需联网加载图片；大于常见图标尺寸时可使用 SVG 参考或提高导出采样分辨率，位图烘焙版受分辨率限制。

正式流体场以母图完整光照为采样源，按周期连续改变半径映射、角向映射、宽度与亮度。内圈使用较小幅度的反射流动，在亮边附近平滑连接外晕的舒展；2/3/5 阶角向波错开时间相位。外侧加入很淡的柔光波肩，让左、下方向也能响应呼吸。固定黑色实体位于光照层下方，其几何和变换不参与循环变化，球面反光本身持续运动。周期使用整数谐波，循环边界的帧差应与普通相邻帧相当。

Lottie 的循环开关由播放器设置，不由文件自动决定。按 [lottie-web 官方 loadAnimation 说明](https://github.com/airbnb/lottie-web/wiki/loadAnimation-options)，传入 `renderer: 'svg'`、`animationData`，前三种设 `loop: true`，展开设 `loop: false`。项目自定义 `meta.loop` 只给宿主提供此信息。`preview.html` 正是这样运行交付数据，展开由用户点击重播；GIF 为展示而每 1.8 秒重播一次展开，不改变一次性素材。

静态主图、Lottie 内嵌图层、独立 SVG 和 CSS 参考使用同一球体光照母版。Lottie/PNG 序列为正式的已烘焙流体场；SVG 使用位移噪声滤镜提供较轻的近似流体参考，不能声称与烘焙帧完全相同。减少动态效果时保留静态显示，停止形变、环流与展开。

## 重新生成与验收

在仓库根目录执行：

```powershell
python packages/branding/assets/LS_VoidRing/tools/render_brand_assets.py
```

兼容入口按顺序执行球体图层导出、SVG/PNG/Lottie 导出、浏览器验证、GIF 编码。再生成直接使用已保存的用户母图，不请求 imagegen。透明光照层按黑底发光与实体球体遮罩导出，黑底合成回读除 0–3/255 的空背景噪声清理外保留母版颜色；记录见 `qa/sphere_source_validation.json`。需要 Node.js、sharp、Playwright、Chromium 和 Pillow；已有 Codex 桌面依赖可直接使用，也可用 `SHARP_MODULE`、`CODEX_ASSET_NODE_MODULES`、`CHROMIUM_PATH` 指定本地位置。这些依赖仅用于设计资源导出，不增加 App 运行时依赖。

仅修改动效时执行 `node packages/branding/assets/LS_VoidRing/tools/render_fluid_motion.mjs`，随后运行 `verify_brand_assets.mjs` 和 `export_preview.py`。该路径只更新动效、帧序列与预览，保持已经确认的静态主图和应用图标资源不变。

验证覆盖：12 个 PNG 尺寸与纯黑背景/近黑不透明球体中心/透明角；128px 以上版本在球面内侧存在暖色反射，防止再退化为平面圆盘；7 个 Windows ICO 尺寸；App PNG 与主版一致；四个 JSON 被真实 lottie-web 5.12.2 成功加载并显示变化；前三种动效的黑色实体图层几何与变换固定，内圈反光、折射亮边及上/右/下/左四个外侧光晕区域均存在变化；循环末端帧差不超过普通相邻帧差的两倍；展开最终内容淡出；减少动态效果静态显示；390px 预览无横向溢出；无浏览器脚本错误。视觉判断仍需要结合母图、32px 实际图与动效预览，不以结构检查代替审美判断。

播放器副本位于 `preview/lottie_svg.min.js`，来自 airbnb/lottie-web 官方 `v5.12.2`，MIT 许可证原文随交付保存在 `LOTTIE_LICENSE`。预览不需要 CDN 或网络。

## 产品接入范围

导出同步更新 `packages/app/resources/littlesheep-icon.png` 与 `littlesheep.ico`。ICO 包含 16、24、32、48、64、128、256 像素，每个尺寸由同一球体光照母版导出。资源文件名保持现有 App 窗口、托盘、启动页、安装器与快捷方式的加载约定，重新生成后须重跑 `pnpm run ensure:app-build`。

四种动效已接入 LittleSheep：启动与空白对话使用待机呼吸，空白对话初次挂载播放一次 420ms 展开，历史读取使用加载环流，顶部任务条按真实运行/工具/思考状态切换，正在接收的思考行使用思考潮汐。失败、暂停与等待用户时停止工作动效；系统减少动态效果、页面隐藏和图标离开视口时使用静态母版。

应用使用 `tools/export_app_motion.py` 从已确认 PNG 序列导出三份透明无损 WebP、小尺寸启动素材和透明静态 `mark.png`，只合成不透明黑色球体与完整光照，不叠加黑色圆角底板。静态回退与展开也使用透明图；桌面/托盘等原生图标保留已确认底板。动效保持 30fps 的完整光照变化，不增加 App 运行时依赖。导出到 `packages/app/resources/void-ring/` 后须重新运行 `pnpm run ensure:app-build`。产品状态映射与真实 Electron 验收分别验证；这些结果不证明安装包或系统图标缓存已更新。
