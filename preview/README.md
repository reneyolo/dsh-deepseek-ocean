# 预览与截图基建（t1）

本目录把 `lib/client.js` 当作浏览器模块直接驱动，用于在没有 DSH 界面的情况下渲染固定帧、做视觉评审。

## 文件

| 路径 | 作用 |
| --- | --- |
| `preview/index.html` | 伪造 `window.__ModuleLoader__`，加载 `../lib/client.js`，取出 `OceanEngine / World / AsciiRenderer`，在整屏 canvas 上渲染一帧 |
| `preview/presets.js` | 预览用风格预设（纯数据）；也支持 `lib/client.js` 将来导出的 `PRESETS`；t5 的 a/b/c 在此 |
| `preview/overlay.js` | 预览后处理：A/B 的 top haze（grade）与 C 的 scanlines/ticks/guides（tech，alpha ≤0.05） |
| `preview/glass-fixture.svg` | 全屏 UI 合成用的 t3 暗色玻璃 fixture（252/876/312 三栏） |
| `scripts/shoot.mjs` | 截图命令行：Chrome headless（关键节点复核）/ 软件光栅化（日常）；`--no-tech` 关闭 C 的科技层 |
| `scripts/render-software.mjs` | 软件引擎：同一份 `lib/client.js` + Canvas2D→SVG 记录器 + sharp；应用 overlay.js |
| `scripts/glass-composite.mjs` | 把 B 海洋按 0.62 不透明度 + 1.2px 模糊合成到玻璃 fixture 下 |
| `shots/` | 截图、评审与出图说明 |

## 快速开始

```powershell
cd dsh-deepseek-ocean

# 日常：software 引擎（稳定、快、无需审批）
node scripts/shoot.mjs --engine software --size 1440x900 --preset default --out shots/baseline-1440x900.png
node scripts/shoot.mjs --engine software --size 1920x1080 --preset default --out shots/baseline-1920x1080.png

# 带预览 HUD / 面板钩子
node scripts/shoot.mjs --engine software --size 1440x900 --preset default --panel --out shots/panel.png

# 只检查解析结果，不启动浏览器
node scripts/shoot.mjs --size 1440x900 --preset default --dry-run

# 关键节点：真实 Chrome（captain 在 danger-full-access 下执行）
node scripts/shoot.mjs --engine chrome --size 1440x900 --preset default --out shots/baseline-chrome-1440x900.png
```

## 参数

- `--size WxH`：视口 / 截图尺寸。
- `--preset NAME`：预设名；也可传内联 JSON 设置对象，如 `--preset '{"species":"shark"}'`。
- `--out PATH`：输出 PNG；相对路径按当前工作目录解析。
- `--panel`：显示预览 HUD（Chrome 侧为 DOM HUD；software 侧绘制到 SVG）。
- `--seed N`：确定性种子，默认 `20260101`。
- `--frames N`：截图前模拟的 1/60 秒步数，默认 `240`。
- `--dpr N`：设备像素比，默认 `1`。
- `--engine software|chrome`：默认 `software`；`--chrome` 用于真实 Chrome 复核，`--software` 为显式别名。
- `--dry-run`：打印解析后的 URL / 参数后退出。

## 确定性

- 预览和软件引擎都会在加载模块、构造 `World`、模拟步进期间用 `mulberry32(seed)` 替换 `Math.random`，结束后恢复。
- 页面同步渲染完成后才设置 `window.__PREVIEW_READY = true` / `<html data-preview="ready">`。
- Chrome 侧在渲染后调用 `engine.destroy()`，避免 ResizeObserver 的延迟回调 resize canvas 导致截图空白。
- 默认使用 `--virtual-time-budget` 和 `--run-all-compositor-stages-before-draw`，让截图等待合成完成。

## 预设解析顺序

1. `preview/presets.js` 的 `window.__OCEAN_PRESETS__`
2. `lib/client.js` 导出的 `PRESETS` / `presets`（同名覆盖）
3. 预设名 `default` / `none` → 空补丁
4. 显式 JSON → 直接作为 settings 补丁

`OceanEngine#applyPreset` / `setPreset` / 模块级 `applyPreset` 若存在会优先调用；否则走 `engine.setSettings(patch)`。`patch.sharks` 会用来重建 `World`。

## 面板钩子

Chrome 预览在 `--panel` 时先显示内置 HUD，然后如果模块导出 `mountPreviewPanel(engine, { hud, params, state, info })`，会调用它。UI 任务可以把真实参数面板挂到这个钩子上，供截图评审；软件引擎暂不支持该钩子。

## t5 候选（A/B/C）

- 预设：`preview/presets.js` 的 `a` / `b` / `c`。A 轻微提亮；B 雾感纵深；C 与 B 同场，额外叠科技层。
- 后处理：`preview/overlay.js` 由 `window.__OCEAN_PRESET_META__` 驱动，Chrome 预览和软件引擎共用；C 的 scanline/ticks/guides 全部 alpha ≤0.05。
- 一键关闭科技层：`--no-tech`（或 URL `tech=0`）。关闭后 C 与 B 逐字节一致（已用 320x200 验证）。
- 玻璃合成：`scripts/glass-composite.mjs` + `preview/glass-fixture.svg`，输出 `shots/glass-b-1440x900.png`；按 t3 evidence 的三栏几何与 0.34/0.40 玻璃 alpha 复刻。
- 评审与 findings：`shots/t5-review.md`、`shots/t5-findings.json`、`shots/t5-evidence.json`。

## 引擎与复核约定

- **t5 / t6 日常出图用 software 引擎**：`--engine software` 稳定、快、无需审批。
- **真实 Chrome 复核由 captain 在关键节点执行**：t5 选定候选后、t6 定稿、t8 最终图。真实 Chrome 需要一次 `danger-full-access` 提权，不要在 `workspace-write` 沙箱里反复尝试启动 Chrome。
- 每张图都在 [shots/README.md](../shots/README.md) 登记引擎、preset、seed、frames、panel，便于 Chrome 与 software 对照。

### 沙箱为什么默认跑不了 Chrome

`workspace-write` 沙箱会把子进程 token 降为 Low integrity（`whoami /groups` 显示 `Mandatory Label\Low Mandatory Level`）。Chromium 启动时创建 Mojo 命名管道会被拒绝：

```
FATAL:mojo/public/cpp/platform/platform_channel.cc Check failed: ... 拒绝访问 (0x5)
crashpad_client_win.cc OpenProcess: 拒绝访问 (0x5)
```

Chrome 与 Edge 都受影响。`danger-full-access` 下可以正常启动；captain 已用它生成 `shots/baseline-chrome-1440x900.png`，与 software 基线同构图，仅点阵相位/抗锯齿有细微差异。`scripts/shoot.mjs` 的 Chrome 路径本身是完整可用的。

### 软件引擎的限制

- 使用 sharp（DSH 自带或 `npm i sharp`）；文字由 Pango/fontconfig 排版，和 Chrome 的抗锯齿/字宽略有差异。
- Canvas2D 记录器覆盖本渲染器当前用到的 API（fillRect / path / stroke / fillText / globalAlpha / 渐变）。渲染内核以后新增 `filter` / `globalCompositeOperation` / `drawImage` 等会打印 `unsupported canvas API`，需要补记录器。
- `fontconfig` 在 Low integrity 下会打印无写缓存目录的告警，但不影响输出。

## 基线

- `shots/baseline-1440x900.png`、`shots/baseline-1920x1080.png`：software 引擎，default 预设，seed 20260101，240 帧，无 panel。
- `shots/baseline-chrome-1440x900.png`：真实 Chrome 对照图（captain，danger-full-access），同参数。

重新生成：

```powershell
npm run shots:software      # 日常：software
npm run shots:baseline      # 关键节点：真实 Chrome（需要 danger-full-access）
```
