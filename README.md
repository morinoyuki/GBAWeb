# GBA Web

GitHub: <https://github.com/morinoyuki/GBAWeb>

[![Deploy to Cloudflare Pages](https://github.com/morinoyuki/GBAWeb/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/morinoyuki/GBAWeb/actions/workflows/deploy-pages.yml)

在浏览器里运行 Game Boy Advance 游戏。模拟器核心是 **mGBA 2.5.1** 编译成的
WebAssembly；前端、存档系统、输入与界面都是本项目自己写的。

> 本站/本仓库不附带任何商业游戏 ROM。请使用你自己合法拥有的游戏备份。
> 内置的「GBA Web Demo」是本项目原创的 homebrew 演示。

## 功能

- **直接运行 GBA 游戏**：支持 `.gba` / `.agb` / `.bin`，也支持 `.zip`（自动选取压缩包内最大的 ROM）。拖放或选择文件即可。
- **即时存档**：每个游戏 8 个槽位，带缩略图，可保存/读取/导入/导出；存档保存在浏览器 IndexedDB 中，刷新/重开浏览器不丢。
- **电池存档（.sav）**：游戏写入存档时自动捕获，暂停/返回首页/定时同步；导入/导出时会明确显示当前目标游戏，文件名也带游戏名。
- **加速**：2× / 3× / 4× / 8× 可选；按住 `Tab` 临时加速，松开恢复。
- **倒带**：按住 `Backspace` 或界面上的倒带按钮回退。
- **崩溃恢复**：核心自动存档（默认每 60 秒），载入游戏时可选择恢复到上次位置，也可在设置中手动读取。
- **输入**：键盘（可在设置中自由改键）、标准手柄（Gamepad API）、移动端触屏虚拟按键。
- **显示**：整数倍缩放、全屏、像素级缩放（`image-rendering: pixelated`）、实时帧率。
- **游戏库**：最近游玩、继续上次、游玩时长、缩略图、删除游戏及其全部存档。
- 切换到其他标签页时自动暂停，回到页面后点击画面即可继续。
- 全屏时顶部信息栏和底部工具栏会在 2.6 秒无操作后自动隐藏，移动鼠标、触摸或按键即可恢复。
- **纯本地**：ROM、存档都不会上传到任何服务器；没有后端。

## 快速开始

不需要构建，核心文件已经放在 `vendor/` 里。

```bash
# Node.js 18+
node serve.mjs
# 或
npm start
# 自定义端口
node serve.mjs --port 8080
# 让局域网内的手机访问（注意：非 localhost 的 HTTP 可能无法使用 SharedArrayBuffer，
# 手机测试建议用 localhost 或 HTTPS 部署）
node serve.mjs --host 0.0.0.0 --port 8080
```

打开 <http://127.0.0.1:5173/>，点击「打开 ROM」选择 `.gba`（或 `.zip`），
也可以先点「内置演示」体验存档/加速/倒带。

演示 ROM 的操作：方向键移动绿色光标，`A` 切换小球颜色，`Start` 重置位置。

> **必须使用带 COOP/COEP 响应头的服务器。** `serve.mjs` 已经设置好：
> `Cross-Origin-Opener-Policy: same-origin` 和
> `Cross-Origin-Embedder-Policy: require-corp`。
> 直接用 `file://` 打开页面无法启用 WASM 多线程。
> 手机/平板通过局域网访问时，请使用 HTTPS（或手机上的 localhost 端口转发），
> 因为 SharedArrayBuffer 只在安全上下文中可用。

## 操作

### 键盘

| 按键 | 功能 |
| --- | --- |
| 方向键 / `WASD` | 十字键 |
| `Z` 或 `J` | A |
| `X` 或 `K` | B |
| `Q` 或 `U` | L |
| `E` 或 `I` | R |
| `Enter` | Start |
| `Shift` | Select |
| 按住 `Tab` | 加速（默认 4×） |
| 按住 `Backspace` | 倒带 |
| `P` | 暂停 / 继续 |
| `F2` / `F4` | 快速保存 / 读取当前槽位 |
| `[` / `]` | 切换槽位 |
| `G` | 打开存档槽位面板 |
| `M` | 静音 |
| `F` | 全屏 |
| `H` / `O` | 帮助 / 设置 |

以上是默认键位。打开「设置 → 按键」即可改键：点击某个键位后按下新按键，按 Esc 取消；
同一个物理按键只会绑定一个动作；每个动作最多可以添加 4 个键位。手柄键位固定。

### 手柄

标准映射：A→A，B→B，十字键/左摇杆→方向，L1/R1（L2/R2）→L/R，
Start/Back→Start/Select。连接后会自动识别。

### 触屏

手机/平板会自动显示虚拟按键（也可在设置中强制显示或关闭）：
左侧十字键、右侧 A/B、上方 L/R、下方 Select/Start。

## 存档说明

- **即时存档**保存在 IndexedDB 的 `states` 表里，按 ROM 内容哈希（SHA-256）关联。
  相同的 ROM 改名/移动位置后仍然能读到原来的存档。
- 每个槽位可以保存、读取、导出（`.ssN`）和删除；面板底部的「导入存档到槽位 N」可以导入本应用或
  mGBA 导出的 `.ssN` / PNG 状态文件（文件内需含 `gbAs` 数据块）。导入前会显示当前游戏名和当前槽位。
- **电池存档**会被自动同步：游戏写存档时（`saveDataUpdated` 回调）、暂停、
  返回首页、每 10 秒以及页面隐藏时都会尝试写入 IndexedDB。
- 设置 → 存档里会显示「当前目标游戏」；导出文件名是 `<游戏名>.sav`，导入会覆盖**当前这个游戏**的
  电池存档（导入前会再次确认）。
- **自动存档**使用 mGBA 的 autosave 机制，默认每 60 秒一次，用于崩溃恢复。
  可以在设置里关闭，或关闭「载入游戏时恢复自动存档」，也可以在设置中手动「读取自动存档」。
  导入电池存档时会清除该游戏旧的自动存档，避免旧状态覆盖刚导入的 .sav。
- 清除浏览器站点数据会同时删除 ROM、电池存档和即时存档。重要进度请使用「导出」。

## 部署

mGBA 的 WASM 版本使用 pthreads/SharedArrayBuffer，页面必须处于
**cross-origin isolated** 状态。服务器需要返回：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

仓库里已经提供：

- `serve.mjs`：本地/自托管 Node 服务器（自动加头）。
- `_headers`：Netlify、Cloudflare Pages 等。
- `vercel.json`：Vercel。

### 自动部署（GitHub Actions）

`main` 分支的每次 push 会自动触发 `.github/workflows/deploy-pages.yml`，
构建静态站点并部署到 Cloudflare Pages 项目 `gba-web`，线上地址为
<https://gba.sox.lol>。

首次启用需要在 GitHub 仓库的
**Settings → Secrets and variables → Actions** 中添加一个 secret：

- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token，权限为
  **Cloudflare Pages: Edit**（Account resources 选择本项目所在账户）。

Account ID 已直接写在 workflow 中（它不是密钥）。添加后推送任意提交，或到
**Actions → Deploy to Cloudflare Pages → Run workflow** 手动运行一次即可。

Nginx 示例：

```nginx
location / {
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
    try_files $uri $uri/ /index.html;
}
```

### GitHub Pages / 无法加响应头的静态托管

页面里已经引入了根目录下的 `coi-serviceworker.js`。在没有 COOP/COEP 响应头时，
它会注册一个 Service Worker，为同源响应注入隔离头并自动刷新一次页面，
从而启用 SharedArrayBuffer。需要 **HTTPS**（或 localhost）。

如果托管平台已经返回正确的响应头，该脚本会自动跳过，不会重复刷新。

### MIME

确保 `.wasm` 以 `application/wasm` 返回（`serve.mjs`、Netlify、Vercel、
GitHub Pages 默认都正确）。

## 实现结构

```
index.html              页面与界面
styles.css              深色 UI / 移动端布局
js/app.js               应用控制器：UI、存档流程、设置、快进、倒带
js/emulator.js          mGBA WASM 封装：加载 ROM、状态、电池存档、截图
js/input.js             键盘 / 手柄 / 触屏输入（可改键，按来源合并按键）
js/rom.js               .gba/.zip 解析、头部检查、SHA-256
js/storage.js           IndexedDB（ROM / 电池存档 / 即时存档 / meta）
vendor/mgba.js|wasm     mGBA 2.5.1 WASM 核心（未修改）
vendor/fflate.js        ZIP 解压
coi-serviceworker.js     无响应头托管时的 COI 兜底（必须在根目录）
demo/gba-web-demo.gba   原创 homebrew 演示（ARM 汇编，MIT）
tools/make-demo-rom.py  用 Keystone 汇编演示 ROM
tests/e2e.mjs           Playwright 端到端测试
```

一些实现细节：

- 核心以固定 240×160 渲染到 `<canvas>`，CSS 负责等比缩放/全屏。
- 输入由前端统一处理（`buttonPress`/`buttonUnpress`），并关闭核心自带的 SDL 键位处理，
  避免与页面快捷键冲突。
- 即时存档是 mGBA 原生状态文件（PNG 容器 + `gbAs` 数据块），
  从核心的 `/data/states/<rom>.ssN` 读出后存进 IndexedDB，读取时再写回。
- 电池存档在 `loadGame` **之前**写入 `/data/saves/<rom>.sav`，确保游戏启动时能读到。
- 每次重新载入 ROM 都会重新挂接核心回调（mGBA 在创建新 core 时会清空回调）。

## 测试

```bash
npm install
npx playwright install chromium
npm test
```

端到端测试会启动本地服务器，加载内置演示 ROM，检查：

- mGBA 核心启动、帧率、画面非空
- 键盘与触屏输入、暂停、倒带
- 自定义键位保存与即时生效、恢复默认键位
- 1× / 4× 实际帧数倍率、`Tab` 临时加速
- 即时存档保存后继续运行、读取后**逐像素恢复**、导出后重新导入
- 电池存档导入、刷新页面后仍然存在
- 即时存档刷新后仍然存在、zip 载入、重置、全屏
- 移动端 3:2 布局、触屏按键在画面下方且不遮挡

Linux 上如果 Playwright 缺少 `libnss3` / `libnspr4`，可执行
`npx playwright install --with-deps chromium`（需要 sudo），或自行安装这两个库。

### 关于精度

开发时还用 MIT 许可的 [jsmolka/gba-tests](https://github.com/jsmolka/gba-tests)
做过人工验证：

- `save/sram.gba` → **All tests passed**（存档类型检测与 SRAM 正常）
- `ppu/hello.gba` → 正确显示 “Hello world!”
- `thumb.gba` / `arm.gba` → 除一个已知的 mGBA 边角行为外全部通过：
  `STM` 指令的基址寄存器同时出现在寄存器列表中且为编号最小寄存器时的行为
  （[mGBA issue #3062](https://github.com/mgba-emu/mgba/issues/3062)，开源未修复）。
  这是编译器不会生成、游戏也不会依赖的极端情况，不影响正常游戏。

### 重新生成内置演示 ROM

`demo/gba-web-demo.gba` 已随仓库提供；修改 `tools/make-demo-rom.py` 后可重新生成：

```bash
python3 -m venv .venv
.venv/bin/pip install keystone-engine
.venv/bin/python tools/make-demo-rom.py
```

## 已知限制

- 使用 mGBA 的 **HLE BIOS**，不需要也不支持外部 `bios.bin`。极少数依赖真实 BIOS 的功能可能不同。
- 没有实现联机/对战线、金手指界面、陀螺仪/太阳传感器等外设。
- 音频使用 SDL2 的 ScriptProcessorNode（浏览器已标记 deprecated，但可用）。
  移动端首次需要点一下屏幕以解锁音频。
- 性能取决于设备；较弱的手机建议关闭「整数倍缩放」并使用较小的画面。
- 浏览器站点数据被清除后，存档会一起丢失；请定期导出重要存档。

## 许可证与致谢

- 本项目前端与演示 ROM：MIT（见 `LICENSE`）。
- 模拟器核心：[mGBA](https://mgba.io)（MPL-2.0），WASM 构建来自
  [@thenick775/mgba-wasm](https://github.com/thenick775/mgba)。
- ZIP 解压：[fflate](https://github.com/101arrowz/fflate)（MIT）。
- COI 兜底：[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)（MIT）。
- 精度测试 ROM：[jsmolka/gba-tests](https://github.com/jsmolka/gba-tests)（MIT，未随应用分发）。

第三方许可证全文见 `NOTICE` 与 `licenses/`。
