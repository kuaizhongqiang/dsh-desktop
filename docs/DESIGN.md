# dsh-desktop 设计文档（Paper）

> 状态：v0.2（已按评审意见修订，见 [docs/DESIGN-REVIEW.md](DESIGN-REVIEW.md)）
> 适用范围：dsh-desktop 桌面客户端项目
> 关联仓库：[kuaizhongqiang/dsh-desktop](https://github.com/kuaizhongqiang/dsh-desktop)（本仓库），子模块 `deepseek-harness/`（上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，只读，零修改）

---

## 1. 项目概述

### 1.1 背景

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（以下简称 **dsh**）是一个基于 Cordis 的插件化 Agent 运行时，自带 Web UI（`dsh web` 一条命令即可启动服务并托管浏览器界面，默认监听 `http://127.0.0.1:3080`）。

dsh 本身是面向"命令行 + 浏览器"形态的产品。本项目为其补充一个 **Windows 优先的桌面端 App**：

- **不改动 dsh 一行代码**：dsh 作为独立子模块引入，仅作为可执行依赖被消费；
- **复用 dsh server 与 Web UI**：桌面 App 负责在本地拉起 dsh server，并用 Electron 窗口内嵌其 Web UI；
- **补齐桌面体验**：系统托盘、单实例、端口冲突处理、日志面板、设置页等纯客户端能力全部为本项目新增。

### 1.2 目标

1. 提供原生桌面外壳（安装包、托盘、自动更新、签名），让**不想接触命令行的用户**无需安装 Node、无需敲任何命令即可使用 dsh；
2. 以**双版本发布模型**交付：Slim 版（面向开发者，最小安装包 + 首启引导）与 Full 版（面向轻度用户，全量自包含）；
3. 保持 dsh 子模块**完全不变**，本项目所有代码均为新增。

### 1.3 非目标（v1 不做）

- 不修改、不 fork dsh 源码；
- 不重做 dsh Web UI（纯内嵌，标准窗口壳）；
- 不做 server 进程自动重启（崩溃后由用户手动一键重启，见 §7.1）；
- 不做 macOS/Linux 支持（Windows 优先，架构上预留跨平台空间）。

### 1.4 目标用户与使用场景（评审 1.1）

> 评审结论：补用户画像后方可确认双版本模型。以下画像经项目方确认（2026-08-17）。

| 画像 | 特征 | 核心诉求 | 对应版本 |
|---|---|---|---|
| **A. 轻度用户** | 不熟悉命令行/Node，只想"双击图标就能和 dsh 对话" | 安装即用、零环境配置、托盘常驻、自动更新无感 | **Full 版**（主打） |
| **B. 开发者用户** | 已熟悉 CLI 与 dsh，但想要桌面体验：托盘常驻、多开隔离、日志可视化、不用开浏览器 Tab | 最小安装包、已有环境直接复用、日志与进程状态透明 | **Slim 版**（主打） |

**双版本模型自洽性**：A 画像无法接受"先装 Node 再装 App"，对应 Full 版（自包含）；B 画像本可直接 `dsh web`，Slim 版的价值在于**桌面壳能力**（托盘/日志/端口管理/自动更新）而非"帮用户装 dsh"——因此 Slim 版的引导流程面向"环境已具备的开发者做快速校验"，环境缺失时给显式指引（§6.3）。

---

## 2. 名词与角色

| 名词 | 说明 |
|---|---|
| **dsh** | DeepSeek Harness，本项目依赖的上游 Agent 运行时 |
| **dsh server** | 由 `dsh` CLI 启动的服务进程（`dsh --profile web`），承载 API 网关并托管 Web UI |
| **dsh Web UI** | dsh 的浏览器端界面（`apps/web` 的构建产物 dist），由 server 同进程托管 |
| **桌面 App** | 本项目交付物（Electron 应用），管理 dsh server 子进程并内嵌其 Web UI |
| **Full 版 / Slim 版** | 同一套代码的两种打包形态，见 §6 |

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│ dsh-desktop（Electron App，TypeScript）                    │
│                                                          │
│  ┌───────────────┐  spawn / 管理   ┌───────────────────┐ │
│  │ Electron 主进程 │ ──────────────→ │ dsh server 子进程  │ │
│  │ (Node 运行时)   │  健康探测就绪    │ dsh --profile web  │ │
│  └───────┬───────┘                │ 127.0.0.1:<port>   │ │
│          │ load                    └───────────────────┘ │
│  ┌───────▼──────────────────────┐                        │
│  │ BrowserWindow（标准窗口壳）     │                        │
│  │   └─ 内嵌 dsh Web UI          │                        │
│  └──────────────────────────────┘                        │
│  托盘 │ 单实例锁 │ 端口 fallback │ 日志面板 │ 设置页         │
└──────────────────────────────────────────────────────────┘
```

关键链路：

1. 主进程启动 → 单实例锁校验 → 读取设置（端口等）→ spawn dsh server；
2. 主进程以**健康探测为唯一就绪判定**（评审 2.3：轮询 `http://127.0.0.1:<port>/` 返回 200 即就绪，不解析 stdout 文本格式）；
3. 端口就绪后创建 BrowserWindow，加载 `http://127.0.0.1:<port>`；
4. App 退出时向子进程发送优雅退出信号，超时后强制终止并清理进程树。

---

## 4. 技术决策记录

> 决策项均经需求确认（2026-06/08 与项目方多轮问答），标注 ✅ 为已确认。

| # | 决策项 | 结论 | 依据/备注 |
|---|---|---|---|
| D1 | 桌面框架 | **Electron**（TypeScript）✅ | 与 dsh 同为 Node/TS 生态；可 spawn 子进程；打包链路成熟 |
| D2 | server 连接方式 | **内置启动（本地 spawn）** ✅ | App 管理 dsh server 全生命周期；不做远程连接（v1） |
| D3 | UI 策略 | **内嵌 dsh 现有 Web UI** ✅ | dsh 零修改；标准窗口壳包裹 |
| D4 | 目标平台 | **Windows 优先** ✅ | 架构预留跨平台 |
| D5 | 运行时策略 | **双版本** ✅ | Full 版捆绑官方 Node.exe；Slim 版首启引导（见 §6） |
| D6 | dsh 来源 | **子模块原样构建** ✅ | 锁定 commit `47f9438`；`pnpm install && pnpm build && pnpm build:web` |
| D7 | 代码形态 | **同一套代码，双打包配置** ✅ | electron-builder 两套配置产物 |
| D8 | 分发 | **NSIS 安装包 + electron-updater + 代码签名** ✅ | 签名证书与更新源待提供（见 §10.1） |
| D9 | 窗口外观 | **标准窗口壳** ✅ | 不做无边框自定义标题栏 |
| D10 | 目标用户 | **双画像**（轻度用户→Full，开发者→Slim）✅ | 评审 1.1，见 §1.4 |
| D11 | Slim dsh 缺失策略 | **首启安装全局 dsh**（`npm i -g`，用户确认权限）✅ | 评审 1.4a，见 §6.3 |
| D12 | 数据目录 | **`%APPDATA%\dsh-desktop`**（userData）✅ | 评审 1.4b，卸载清理一致 |
| D13 | 下载镜像 | **官方默认 + 设置页可配置镜像** ✅ | 评审 1.4c，国内网络硬约束 |

### 4.1 已验证的技术事实（2026-06/08 核实）

| 事实 | 值 | 来源 |
|---|---|---|
| dsh CLI 包 | npm `@deepseek-ai/dsh`，latest `0.1.0-rc.6`；bin `dsh` | npm registry |
| 子模块版本 | 根包 `0.1.0-rc.5`，commit `47f943859b`（master HEAD） | 本仓库子模块 |
| Node 要求 | `^22.19.0 \|\| >=24.0.0` | dsh 根 package.json `engines` |
| pnpm 要求 | `pnpm@11.7.0` | dsh 根 package.json `packageManager` |
| 启动命令 | `dsh --profile web [--host <h>] [--port <p>] [--trusted-host ...]` | dsh `apps/cli/src/args.ts` |
| 默认监听 | `127.0.0.1:3080` | dsh `cordis.patch.yml`（webStartup 默认） |
| 端口 0 语义 | `--port 0` 由 OS 分配空闲端口 | dsh `web-app/startup.ts` |
| 安全约束 | `--host 0.0.0.0` 被 dsh 显式拒绝（防 RCE 暴露到网络） | dsh `web-app/startup.ts` |
| 鉴权模型 | **无 token/密码**；loopback 请求始终受信任，非回环来源需过 `/api` browser-trust 栅栏（DNS-rebinding 防护） | dsh `client/connection/src/api-request-trust.ts` |
| 原生依赖 | **无**（无 binding.gyp/.node/node-gyp）；SQLite 用内置 `node:sqlite` | 子模块扫描 |
| Web UI 产物 | `apps/web` → dist，由 `dsh-host-frontend-static` 服务；**workspace 构建产物，npm 发布链不保证自带** | dsh `frontend-static/index.ts` |
| Electron 内置 Node | Electron 39.x = Node 22.22.1（满足 dsh engines） | releases.electronjs.org |
| 本机构建环境 | Node v24.14.0 ✅；pnpm 11.4.0（需对齐 11.7）；Windows 10 19045 | 本机检测 |

---

## 5. dsh 集成方案（零修改约束）

### 5.1 引入方式与违规校验（评审 2.1）

- `deepseek-harness/` 以 **git submodule** 引入，锁定 commit；
- 上游更新时通过**更新 submodule 指针**同步，**绝不直接修改子模块内文件**；
- **CI 校验（零修改护栏）**：
  1. `git -C deepseek-harness diff --quiet`（子模块工作区必须干净）；
  2. `git ls-files --stage deepseek-harness` 记录的指针 hash 与锁定期望值一致；
  3. 构建脚本在构建前执行上述校验，违规即失败。
- 与 npm 发布版（`0.1.0-rc.6`）的取舍：npm 版 Web UI dist 不保证随包分发，且版本落后/超前不可控，故**统一从子模块构建**。

### 5.2 构建流程（原样构建，零修改）

```
cd deepseek-harness
corepack enable            # 或升级 pnpm 至 11.7.0（packageManager 要求）
pnpm install               # workspace 全量安装（Node ≥22.19）
pnpm run build             # tsc + tsdown 产出 lib/（host + client 双面）
pnpm run build:web         # vite 构建前端 dist/
```

- 构建产物（`apps/cli/lib` + 各包 `lib` + `apps/web/dist` + 生产依赖 `node_modules`）作为 **Full 版** 的打包输入（§6.2）；
- 构建产物目录**加入 `.gitignore`**，不入库。

### 5.3 dsh server 启动参数与就绪判定

```text
dsh --profile web --host 127.0.0.1 --port <port>
```

- `--host` 固定 `127.0.0.1`（dsh 拒绝 `0.0.0.0`，本地回环符合桌面 App 定位与安全模型 §7.2）；
- `--port`：默认取设置页配置（默认 `3080`）；检测到端口占用（EADDRINUSE / 健康探测失败）时回退 `--port 0`（OS 分配）并在 UI/日志提示实际端口；
- **就绪判定（评审 2.3，唯一判定）**：轮询 `http://127.0.0.1:<port>/`，返回 HTTP 200 即就绪。不解析 stdout 文本（消除对 dsh 输出格式的依赖）；实际端口通过探测端口或 `--port 0` + 探测获得。
- 进程健康：就绪后周期性轻量探测（如 10s 间隔）；探测失败连续 N 次 → 判定异常（触发崩溃流程 §7.1）。

---

## 6. 双版本发布模型

> 同一套源码，两套 electron-builder 配置，产出两个安装包。

| 维度 | **Slim 版（开发者）** | **Full 版（轻度用户）** |
|---|---|---|
| 目标用户 | 开发者（画像 B） | 轻度用户（画像 A） |
| 安装包 | 最小（不含 Node、不含 dsh 产物） | 大（捆绑官方 Node.exe + dsh 构建产物） |
| 首启行为 | 环境检测：Node ≥22.19 是否存在 | 直接启动，零检测 |
| 环境缺失处理 | **引导安装**：Node 缺失→引导下载/安装；dsh 缺失→首启 `npm i -g @deepseek-ai/dsh@<锁定版本>`（用户确认权限） | 不适用 |
| 子进程启动 | 系统 `node` + 全局 `dsh` 命令 | 捆绑 `node.exe` + 随包 dsh 产物 |
| 自动更新/签名 | 是 | 是 |

### 6.1 共用代码

主进程/渲染层/托盘/日志/设置/更新逻辑**完全共用**；差异收敛在：

- 打包配置（`electron-builder` 的 extraResources / 文件包含清单）；
- 启动器选择：`resolveRuntime()` 依据发行形态（编译期注入 `APP_VARIANT=full|slim`）与运行环境返回 node 路径与 dsh 入口；
- 环境检查与引导（Slim 专属模块，Full 版编译排除）。

### 6.2 Full 版打包输入与体积预估（评审 2.2）

打包输入：

- 官方 Node 二进制（Windows x64，22.22.x LTS 线，满足 engines）——`scripts/fetch-node.ps1` 下载，校验 SHA256；
- dsh 构建产物（§5.2）与生产依赖；
- 均放入 `extraResources/`（asar 外），子进程直接以真实文件路径启动。

体积量级预估（估算值，M4 实测后校准，国内网络下需关注）：

| 组成 | Full 版 | Slim 版 |
|---|---|---|
| Electron 运行时（含 Chromium） | ~180–220MB（解压） | 同左 |
| 官方 Node.exe | ~30MB | 不打包 |
| dsh 构建产物 + 生产依赖 | ~150–250MB（估算） | 不打包 |
| **NSIS 安装包（压缩后）** | **~120–200MB（估算）** | **~80–120MB（估算）** |
| 首启额外下载 | 无 | Node zip ~30MB + dsh 全局包安装（磁盘占用另计） |

> 说明：dsh 生产依赖规模为首启下载体验的关键变量，M1 构建实测后回填精确值。

### 6.3 Slim 版引导流程（首启）

1. 探测 `node`：`node --version` ≥ 22.19？
2. 探测 dsh：`dsh --version` 可用？
3. 缺失 → 引导页（渲染层，含显式权限确认）：
   - Node 缺失：下载指引（nodejs.org）或**自动下载**（后台下载 + SHA256 校验 + 解压到用户数据目录，需用户确认）；
   - dsh 缺失：执行 `npm install -g @deepseek-ai/dsh@<锁定版本>`（**弹出权限确认**，明示写入位置与磁盘占用；镜像地址可配置，§10.2 决策 3）；
4. 完成后回跳步骤 1 校验，通过即进入正常启动流程。

> 与评审 1.4a 结论一致：Slim 版**不随包携带 dsh 代码**，安装包最小；dsh 通过首启全局安装获得。自动下载/安装均需用户显式确认。

---

## 7. 功能规格（v1）

| 功能 | 说明 | 实现要点 |
|---|---|---|
| **主窗口** | 标准窗口壳内嵌 dsh Web UI | `BrowserWindow` + `loadURL(http://127.0.0.1:<port>)`；就绪前显示启动页 |
| **系统托盘** | 关闭窗口最小化到托盘；托盘菜单：显示/隐藏、重启 server、打开日志、检查更新、退出 | `Tray` + 图标；关闭语义见 §7.1 |
| **单实例锁** | 二次启动聚焦已有窗口 | `app.requestSingleInstanceLock()` + `second-instance` 事件 |
| **端口冲突处理** | 配置端口被占 → 自动回退 OS 分配端口并提示 | 健康探测 + `--port 0` 重试；日志与设置页展示实际端口 |
| **日志面板** | 查看 dsh server 的 stdout/stderr | 环形缓冲（主进程）→ IPC 推送 → 渲染层面板；含导出 |
| **设置页** | 端口、开机自启、数据目录、镜像地址、关于 | `electron-store` 持久化（`%APPDATA%\dsh-desktop`，D12）；`app.setLoginItemSettings` |
| **优雅退出** | 退出时先停 server | SIGTERM → 等待 → 超时 kill；清理子进程树（Windows `taskkill /T` 兜底） |
| **崩溃提示** | server 异常退出时用户可见的恢复路径 | 提示页（退出码/最后日志 + 一键重启 + 打开日志），见 §7.1 |

### 7.1 关键用户流程（评审 1.3）

> 评审结论：缺用户视角状态流转，以下状态机为 v1 定义，M2/M3 实现按此执行。

| 流程 | 用户可见状态流转 | 异常/分支 |
|---|---|---|
| **首次启动** | 启动页（"正在初始化环境…"）→ 环境检测 → 引导页（Slim 缺失项）或直接 → "正在启动 dsh…" → 就绪 → 加载 Web UI | 端口被占：启动页显示"端口被占，自动重试" → 回退成功（提示实际端口）或失败（错误页 + 日志入口） |
| **server 崩溃** | Web UI 加载失败/无响应 → 崩溃提示页（显示退出码、最后 20 行日志、按钮：重启 / 打开日志 / 退出） | 用户点重启 → 回到"正在启动 dsh…"；连续崩溃 3 次 → 提示"请查看日志或切换端口" |
| **端口被占回退** | 提示"端口 3080 被占用，已改用 12345"，日志面板记录；设置页展示当前实际端口 | 用户可在设置页改回固定端口（改后重启 server） |
| **升级（自动更新）** | 检查更新（启动时 + 托盘菜单）→ 提示新版本 → 下载中（可继续使用）→ 安装（App 重启，server 随之重启）→ dsh 会话数据在 userData，升级后延续 | 下载失败/中断 → 下次启动重试；安装需重启时提示保存 |
| **关闭窗口** | 点 X → **默认最小化到托盘**（托盘提示）；托盘菜单"退出"才真正退出；设置页可改"关闭 = 退出" | 首次最小化时气泡提示一次"App 仍在后台运行" |
| **退出** | 托盘"退出" → 优雅停止 server → 进程退出 | server 无响应超时 → 强杀后退出 |

### 7.2 安全与权限边界（评审 2.4）

| 层 | 边界 | 实现 |
|---|---|---|
| dsh server | 仅监听 `127.0.0.1`；**无 token 鉴权**（上游事实）：loopback 来源的 API 请求默认受信任，非回环来源需过 `/api` browser-trust 栅栏 | 固定 `--host 127.0.0.1`，不使用 `--trusted-host`；本机其他进程可访问该端口属 loopback 固有特性，接受并在文档明示 |
| Electron 渲染层 | 不信任任何远程内容（窗口只加载本地 server） | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；仅通过 preload `contextBridge` 暴露最小 IPC API；拦截新窗口/`window.open` 与外部导航 |
| 日志面板 | 只读展示，无文件系统操作暴露 | IPC 只提供读取环形缓冲与导出文件（导出走主进程保存对话框） |
| 引导下载（Slim） | 下载/安装需用户显式确认 | `npm i -g` 与 Node 解压前弹确认，明示目标路径与磁盘占用；镜像仅允许 https |

---

## 8. 目录结构（本项目新增代码）

```
dsh-desktop/
├── deepseek-harness/            # 子模块（只读，仅构建）
├── desktop/                     # ★ 桌面 App（全部新增）
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.ts         # 入口：单实例 → 起 server → 开窗口
│   │   │   ├── dsh-server.ts    # 子进程生命周期（spawn/健康探测/退出）
│   │   │   ├── runtime.ts       # 运行时解析（full/slim 双形态）
│   │   │   ├── tray.ts          # 托盘
│   │   │   ├── settings.ts      # 配置持久化（electron-store）
│   │   │   ├── log-store.ts     # 日志环形缓冲
│   │   │   ├── env-check.ts     # Slim 环境检测与引导（Slim 专属）
│   │   │   └── updater.ts       # electron-updater
│   │   ├── preload/             # contextBridge（最小 IPC 面）
│   │   └── renderer/            # 启动页 / 崩溃提示页 / 日志面板 / 设置页 / 引导页
│   ├── scripts/
│   │   ├── build-dsh.ps1        # 构建子模块（原样 + 零修改校验）
│   │   ├── fetch-node.ps1       # 下载官方 Node.exe（Full）
│   │   └── pack.ps1             # 双版本打包入口
│   ├── build/                   # electron-builder 双配置（full/slim）
│   └── package.json
├── docs/DESIGN.md               # 本文档
├── docs/DESIGN-REVIEW.md        # 评审意见（评审 agent 产出）
└── README.md
```

> 说明：`desktop/` 为独立 npm 工程，与子模块的 pnpm workspace 相互隔离（嵌套 workspace 不互相引用），避免污染 dsh 的依赖树。

---

## 9. 里程碑规划

| 里程碑 | 名称 | 核心交付 | 验收标准（功能级） |
|---|---|---|---|
| **M1** | 最小可用 | 脚手架 + dsh 构建脚本 + spawn dsh → 窗口加载 Web UI | 安装/开发运行后双击，窗口出现并可使用 dsh Web UI |
| **M2** | 桌面能力 | 托盘、单实例、端口 fallback、日志面板、崩溃提示页 | 上述功能逐项可操作、可验证（含 §7.1 流程） |
| **M3** | 设置与引导 | 设置页、开机自启、Slim 环境检测与引导安装 | Slim 版在无 Node 机器上可完成引导并启动 |
| **M4** | 分发 | Full/Slim 双打包、自动更新、签名、发布流水线 | 两个安装包产出，更新链路可走通 |

### 9.1 量化验收指标（评审 1.2，目标值待 M1/M3 实测校准）

| 指标 | 目标值 | 归属 |
|---|---|---|
| 冷启动 → 窗口可交互（环境就绪前提下） | **≤ 8s**（spawn + 健康探测 + Web UI 加载） | M1 |
| server 就绪判定耗时（健康探测首轮） | **≤ 3s** | M1 |
| 端口回退（EADDRINUSE → 新端口可用） | **≤ 5s** | M2 |
| server 崩溃 → 崩溃提示页可见 | **≤ 3s** | M2 |
| Slim 首启引导成功率（网络可达） | **≥ 90%**；单步可中断/可重试 | M3 |
| 升级下载中断恢复 | 下次启动自动续试 | M4 |

### 9.2 排期与关键路径（评审 2.5，待补）

- 时间与人力估算需团队上下文（人数/投入），**暂记为待补**；M1 完成后按实测数据补排期。
- 已识别的关键路径：M1 的 dsh 构建 + spawn 就绪判定；M3 的 Slim 引导（依赖 §10.2 决策）。

---

## 10. 依赖条件与决策记录

### 10.1 需要项目方提供（延后项，评审 3）

- [ ] **Windows 代码签名证书**（M4 签名步骤的前置条件；可用自签临时替代验证流程）；
- [ ] **自动更新分发渠道**（GitHub Releases / 自建服务器 / 其他）；
- [ ] **正式产品名**（暂定 `dsh-desktop`，影响安装包名/窗口标题/托盘）。

### 10.2 开放问题 → 决策记录（评审 1.4：已拍板，含 Owner 与日期）

| 原开放问题 | 决策 | Owner | 决策日期 |
|---|---|---|---|
| Slim 版 dsh 缺失策略 | **首启 `npm i -g @deepseek-ai/dsh@<锁定版本>`（用户确认权限）**，不随包携带 | 项目方（已确认 D11） | 2026-08-17 |
| 数据目录默认值 | **`%APPDATA%\dsh-desktop`（userData）**，设置页可改 | 项目方（已确认 D12） | 2026-08-17 |
| 下载镜像支持 | **官方默认 + 设置页可配置镜像地址**（仅 https） | 项目方（已确认 D13） | 2026-08-17 |

> 决策机制：所有决策由项目方确认，文档记录 Owner 与日期；后续变更走评审更新本文档。

### 10.3 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh `build:web` 依赖完整 workspace 安装（网络/磁盘） | 构建失败 | CI/脚本固化命令；构建产物缓存；锁定 pnpm 版本 |
| pnpm 版本不符（本机 11.4 vs 要求 11.7） | 安装/构建告警或失败 | `corepack` 对齐；脚本内校验 |
| dsh 生产依赖规模大 → 首启下载/安装包体积超预期 | 体验差 | M1 实测回填 §6.2 体积表；评估裁剪（如仅打包 web profile 所需子集） |
| Windows 下子进程清理不彻底（僵尸进程） | 端口/资源残留 | `taskkill /T /F` 兜底 + 启动前端口预检 |
| Slim 引导下载源网络受限 | 首启体验差 | 镜像配置 + 手动指引兜底（D13） |
| dsh 上游变更（submodule 指针漂移） | 行为不一致 | 锁定 commit + CI 零修改校验（§5.1） |
| 签名证书缺失 | M4 阻塞 | 提前申请；未到位前用自签验证流程 |
| 本机其他进程访问 127.0.0.1 端口（无鉴权） | 信息暴露面 | 属 loopback 固有特性，文档明示；不开放 `--trusted-host`/LAN（§7.2） |

---

## 11. 参考

- dsh 仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（子模块只读）
- dsh 架构文档：`deepseek-harness/docs/architecture.md`、`docs/AGENTS.md`
- dsh CLI 参数：`deepseek-harness/apps/cli/src/args.ts`、`packages/bundle/web-app/src/startup.ts`
- dsh 信任栅栏：`deepseek-harness/packages/client/connection/src/api-request-trust.ts`
- Web server 配置：`deepseek-harness/packages/bundle/web-app/cordis.patch.yml`
- Electron 版本/Node 对应：[releases.electronjs.org](https://releases.electronjs.org/)
