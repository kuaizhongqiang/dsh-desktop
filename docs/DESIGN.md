# dsh-desktop 设计文档（Paper）

> 状态：v0.4（按 2026-08-17 复审意见修订，见 [docs/DESIGN-REVIEW.md](DESIGN-REVIEW.md)；复审记录见 issue #32；v0.4 更新 D6 决策）
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
- 不做 macOS/Linux 支持（Windows 优先，架构上预留跨平台空间）；
- **不做远程/多设备访问**（`--host` 固定回环，`--trusted-host` 不启用，依据见 §7.2）。

### 1.4 目标用户与使用场景

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
| **dsh Web UI** | dsh 的浏览器端界面，构建产物为 `@deepseek-ai/dsh-web-frontend` 包内的 `dist/`，由 server 同进程托管 |
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
│  │ (Node 运行时)   │  就绪判定(探测)  │ dsh --profile web  │ │
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
2. **端口策略（复审 1 修订）**：不使用 `--port 0`；主进程先**预申请空闲端口**（`net.Server.listen(0)` 取 OS 分配端口后关闭），再以该已知端口启动 dsh——端口始终可知，无盲区（§5.3）；
3. 主进程以**健康探测为唯一就绪判定**（轮询 `http://127.0.0.1:<port>/` 返回 200），stdout URL 行仅作校验/诊断（§5.3）；
4. 端口就绪后创建 BrowserWindow，加载 `http://127.0.0.1:<port>`；
5. App 退出时向子进程发送优雅退出信号，超时后强制终止并清理进程树。

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
| D6 | dsh 来源 | **npm 锁定包**（`@deepseek-ai/dsh@0.1.0-rc.6`，双版本统一）✅ | 2026-08-17 决策；npm 链自带 Web UI（已核验）；子模块保留为锁定/参考/审计面（§5.1） |
| D7 | 代码形态 | **同一套代码，双打包配置** ✅ | electron-builder 两套配置产物 |
| D8 | 分发 | **NSIS 安装包 + electron-updater + 代码签名** ✅ | 签名证书与更新源待提供（见 §10.1） |
| D9 | 窗口外观 | **标准窗口壳** ✅ | 不做无边框自定义标题栏 |
| D10 | 目标用户 | **双画像**（轻度用户→Full，开发者→Slim）✅ | 评审 1.1，见 §1.4 |
| D11 | Slim dsh 缺失策略 | **首启安装全局 dsh**（`npm i -g`，用户确认权限）✅ | 评审 1.4a，见 §6.3 |
| D12 | 数据目录 | **`%APPDATA%\dsh-desktop`**（userData）✅ | 评审 1.4b，卸载清理一致 |
| D13 | 下载镜像 | **官方默认 + 设置页可配置镜像** ✅ | 评审 1.4c，国内网络硬约束 |

### 4.1 已验证的技术事实（2026-06/08 核实，含复审修正）

| 事实 | 值 | 来源 |
|---|---|---|
| dsh CLI 包 | npm `@deepseek-ai/dsh`，latest `0.1.0-rc.6`；bin `dsh` | npm registry |
| 子模块版本 | 根包 `0.1.0-rc.5`，commit `47f943859b`（master HEAD） | 本仓库子模块 |
| Node 要求 | `^22.19.0 \|\| >=24.0.0` | dsh 根 package.json `engines` |
| pnpm 要求 | `pnpm@11.7.0` | dsh 根 package.json `packageManager` |
| 启动命令 | `dsh --profile web [--host <h>] [--port <p>] [--trusted-host ...]` | dsh `apps/cli/src/args.ts` |
| 默认监听 | `127.0.0.1:3080` | dsh `cordis.patch.yml`（webStartup 默认） |
| 端口 0 语义 | `--port 0` 由 OS 分配空闲端口；**无渠道获知**（子进程 stdout 之外不可见） | dsh `web-app/startup.ts`；复审 1 |
| 就绪信号 | stdout 打印 `dsh web: http://127.0.0.1:<port>`（`printUrl`）；**dsh 官方注释定义为 supervisor 就绪信号** | dsh `web-app/src/index.ts` L159-168 |
| Web UI 供给 | `resolveDistIndex()` = `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` | dsh `web-app/src/index.ts` L116-124 |
| **npm 链完整性（复审修正）** | npm `@deepseek-ai/dsh-web-frontend@0.0.1-rc.5` **4.41MB、含 `./dist/*` 导出**；dsh → dsh-web-app → dsh-web-frontend 依赖链完整 → **npm 安装链自带 Web UI** | npm registry（2026-08-17 核验） |
| 安全约束 | `--host 0.0.0.0` 被 dsh 显式拒绝（防 RCE 暴露到网络） | dsh `web-app/startup.ts` |
| 鉴权模型 | **无 token/密码**；loopback 请求始终受信任，非回环来源需过 `/api` browser-trust 栅栏（DNS-rebinding 防护） | dsh `client/connection/src/api-request-trust.ts` |
| 原生依赖 | **无**（无 binding.gyp/.node/node-gyp）；SQLite 用内置 `node:sqlite` | 子模块扫描 |
| Electron 内置 Node | Electron 39.x = Node 22.22.1（满足 dsh engines） | releases.electronjs.org |
| 本机构建环境 | Node v24.14.0 ✅；pnpm 11.4.0（需对齐 11.7）；Windows 10 19045 | 本机检测 |

---

## 5. dsh 集成方案（零修改约束）

### 5.1 引入方式与违规校验

- `deepseek-harness/` 以 **git submodule** 引入，锁定 commit；
- 上游更新时通过**更新 submodule 指针**同步，**绝不直接修改子模块内文件**；
- **CI 校验（零修改护栏）**：
  1. `git -C deepseek-harness diff --quiet`（子模块工作区必须干净）；
  2. `git ls-files --stage deepseek-harness` 记录的指针 hash 与锁定期望值一致；
  3. 构建脚本在构建前执行上述校验，违规即失败。

**npm 版 vs 子模块版（复审修正 + D6 决策）**：

- v0.2 曾写"npm 版 Web UI dist 不保证随包分发"——**该结论错误**（查证对象是 13KB 的 `dsh-host-frontend-static` 服务端包，dist 实际在 `dsh-web-frontend` 包内，npm 发布版 4.41MB 完整包含）；
- 正确结论：**npm 安装链自带完整 Web UI**（registry 核验 + `resolveDistIndex()` 走包内 `require.resolve`），Slim 版全局安装无 UI 断点；
- **D6 决策（2026-08-17）**：Full/Slim **统一使用 npm 锁定包** `@deepseek-ai/dsh@0.1.0-rc.6` 作为 dsh 产物来源——双版本跑同一 dsh 版本，M1 免 monorepo 全量构建；
- 子模块 `deepseek-harness/` **保留**，角色降为：**版本锁定参照、源码审计面、上游变更跟踪**（升级 dsh 时先在子模块 review 变更再升 npm 版本）；零修改校验（CI）继续对子模块生效。

### 5.2 dsh 产物获取（npm 锁定版）

```
# 产物来源：npm 锁定包（D6，双版本统一）
npm view @deepseek-ai/dsh@0.1.0-rc.6        # 核验版本存在
npm install --prefix <resources>/dsh @deepseek-ai/dsh@0.1.0-rc.6   # Full 版：安装到 extraResources
# Slim 版：首启 `npm i -g @deepseek-ai/dsh@0.1.0-rc.6`（用户确认，见 §6.3）
```

- 产物（CLI lib + 依赖树 + `dsh-web-frontend/dist` Web UI）由 npm 链完整提供（§4.1 已核验）；
- 升级流程：`npm view @deepseek-ai/dsh versions` 确认新版本 → 更新锁定版本（package.json + 文档 + CI 校验）→ 双版本同步升级；
- 原"子模块 pnpm 全量构建"流程**不再使用**（保留于 git 历史作参考）。

### 5.3 dsh server 启动参数与就绪判定（复审 1 修订）

```text
dsh --profile web --host 127.0.0.1 --port <port>
```

- `--host` 固定 `127.0.0.1`（dsh 拒绝 `0.0.0.0`，本地回环符合桌面 App 定位与安全模型 §7.2）；
- **端口策略**（消除 `--port 0` 盲区，复审 1）：
  1. 首选设置页配置端口（默认 `3080`）；
  2. 被占用时（EADDRINUSE / 健康探测失败）→ **主进程预申请空闲端口**：`net.Server.listen(0)` 取 OS 分配端口后立即关闭，再以该端口启动 dsh（竞态窗口极小，失败则重试）；
  3. **不使用 `--port 0` 传参**——OS 分配端口仅存在于子进程 stdout，与"不解析 stdout"冲突，属逻辑闭环缺口；
- **就绪判定（唯一判定 = 健康探测）**：轮询 `http://127.0.0.1:<port>/`，返回 HTTP 200 即就绪；端口已知（预申请），探测可直接进行；
- stdout 的 `dsh web: http://127.0.0.1:<port>` 行（dsh 官方 supervisor 信号）**仅作校验与诊断**（断言与探测端口一致），不作为就绪依据；
- 进程健康：就绪后周期性轻量探测（如 10s 间隔）；连续失败 N 次 → 判定异常（触发崩溃流程 §7.1）。

---

## 6. 双版本发布模型

> 同一套源码，两套 electron-builder 配置，产出两个安装包。

| 维度 | **Slim 版（开发者）** | **Full 版（轻度用户）** |
|---|---|---|
| 目标用户 | 开发者（画像 B） | 轻度用户（画像 A） |
| 安装包 | 最小（不含 Node、不含 dsh 产物） | 大（捆绑官方 Node.exe + dsh 产物） |
| 首启行为 | 环境检测：Node ≥22.19 是否存在 | 直接启动，零检测 |
| 环境缺失处理 | **引导安装**：Node 缺失→引导下载/安装；dsh 缺失→首启 `npm i -g @deepseek-ai/dsh@<锁定版本>`（用户确认权限） | 不适用 |
| 子进程启动 | 系统 `node` + 全局 `dsh` 命令 | 捆绑 `node.exe` + 随包 dsh 产物（npm 锁定包） |
| **Web UI 供给（复审 2）** | **npm 链自带**（`dsh-web-frontend` dist 随包，已验证）；**无断点** | 随包 npm 链自带（同源） |
| **dsh 版本一致性（D6）** | npm `0.1.0-rc.6`（锁定） | **同一 npm 锁定版** `0.1.0-rc.6` ✅ 已统一 |
| 自动更新/签名 | 是 | 是 |

### 6.1 共用代码

主进程/渲染层/托盘/日志/设置/更新逻辑**完全共用**；差异收敛在：

- 打包配置（`electron-builder` 的 extraResources / 文件包含清单）；
- 启动器选择：`resolveRuntime()` 依据发行形态（编译期注入 `APP_VARIANT=full|slim`）与运行环境返回 node 路径与 dsh 入口；
- 环境检查与引导（Slim 专属模块，Full 版编译排除）。

### 6.2 Full 版打包输入与体积预估

打包输入：

- 官方 Node 二进制（Windows x64，22.22.x LTS 线，满足 engines）——`scripts/fetch-node.ps1` 下载，校验 SHA256；
- dsh 产物：`npm install --prefix <resources>/dsh @deepseek-ai/dsh@0.1.0-rc.6` 安装产物（D6，含 Web UI dist）；
- 均放入 `extraResources/`（asar 外），子进程直接以真实文件路径启动。

体积量级预估（估算值，M4 实测后校准，国内网络下需关注）：

| 组成 | Full 版 | Slim 版 |
|---|---|---|
| Electron 运行时（含 Chromium） | ~180–220MB（解压） | 同左 |
| 官方 Node.exe | ~30MB | 不打包 |
| dsh 产物（子模块构建 或 npm 链） | ~150–250MB（估算；npm 链实测约 ≤100MB） | 不打包 |
| **NSIS 安装包（压缩后）** | **~120–200MB（估算）** | **~80–120MB（估算）** |
| 首启额外下载 | 无 | Node zip ~30MB + dsh 全局包安装（磁盘占用另计） |

> 说明：dsh 生产依赖规模为首启下载体验的关键变量，M1 实测后回填精确值。

### 6.3 Slim 版引导流程（首启）

1. 探测 `node`：`node --version` ≥ 22.19？
2. 探测 dsh：`dsh --version` 可用？
3. 缺失 → 引导页（渲染层，含显式权限确认）：
   - Node 缺失：下载指引（nodejs.org）或**自动下载**（后台下载 + SHA256 校验 + 解压到用户数据目录，需用户确认）；
   - dsh 缺失：执行 `npm install -g @deepseek-ai/dsh@<锁定版本>`（**弹出权限确认**，明示写入位置与磁盘占用；镜像地址可配置）；
4. 完成后回跳步骤 1 校验，通过即进入正常启动流程。

> - 与 D11 结论一致：Slim 版**不随包携带 dsh 代码**，安装包最小；dsh 通过首启全局安装获得；
> - **Web UI 供给（复审 2 澄清）**：全局安装的 npm dsh 链自带 `dsh-web-frontend/dist`（4.41MB，registry 已核验），`dsh --profile web` 可直接托管 UI——**无隐藏断点**；M1 用真实安装实测确认一次即可；
> - 自动下载/安装均需用户显式确认。

---

## 7. 功能规格（v1）

| 功能 | 说明 | 实现要点 |
|---|---|---|
| **主窗口** | 标准窗口壳内嵌 dsh Web UI | `BrowserWindow` + `loadURL(http://127.0.0.1:<port>)`；就绪前显示启动页 |
| **系统托盘** | 关闭窗口最小化到托盘；托盘菜单：显示/隐藏、重启 server、打开日志、检查更新、退出 | `Tray` + 图标；关闭语义见 §7.1 |
| **单实例锁** | 二次启动聚焦已有窗口 | `app.requestSingleInstanceLock()` + `second-instance` 事件 |
| **端口冲突处理** | 配置端口被占 → 预申请空闲端口回退并提示 | 预申请端口 + 健康探测；日志与设置页展示实际端口（§5.3） |
| **日志面板** | 查看 dsh server 的 stdout/stderr | 环形缓冲（主进程）→ IPC 推送 → 渲染层面板；含导出 |
| **设置页** | 端口、开机自启、数据目录、镜像地址、关于 | `electron-store` 持久化（`%APPDATA%\dsh-desktop`，D12）；`app.setLoginItemSettings` |
| **优雅退出** | 退出时先停 server | SIGTERM → 等待 → 超时 kill；清理子进程树（Windows `taskkill /T` 兜底） |
| **崩溃提示** | server 异常退出时用户可见的恢复路径 | 提示页（退出码/最后日志 + 一键重启 + 打开日志），见 §7.1 |

### 7.1 关键用户流程

| 流程 | 用户可见状态流转 | 异常/分支 |
|---|---|---|
| **首次启动** | 启动页（"正在初始化环境…"）→ 环境检测 → 引导页（Slim 缺失项）或直接 → "正在启动 dsh…" → 就绪 → 加载 Web UI | 端口被占：启动页显示"端口被占，自动重试" → 回退成功（提示实际端口）或失败（错误页 + 日志入口） |
| **server 崩溃** | Web UI 加载失败/无响应 → 崩溃提示页（显示退出码、最后 20 行日志、按钮：重启 / 打开日志 / 退出） | 用户点重启 → 回到"正在启动 dsh…"；连续崩溃 3 次 → 提示"请查看日志或切换端口" |
| **端口被占回退** | 提示"端口 3080 被占用，已改用 12345"，日志面板记录；设置页展示当前实际端口 | 用户可在设置页改回固定端口（改后重启 server） |
| **升级（自动更新）** | 检查更新（启动时 + 托盘菜单）→ 提示新版本 → 下载中（可继续使用）→ 安装（App 重启，server 随之重启）→ dsh 会话数据在 userData，升级后延续 | 下载失败/中断 → 下次启动重试；安装需重启时提示保存 |
| **关闭窗口** | 点 X → **默认最小化到托盘**（托盘提示）；托盘菜单"退出"才真正退出；设置页可改"关闭 = 退出" | 首次最小化时气泡提示一次"App 仍在后台运行" |
| **退出** | 托盘"退出" → 优雅停止 server → 进程退出 | server 无响应超时 → 强杀后退出 |

### 7.2 安全与权限边界（含 `--trusted-host` 取舍，复审 3）

| 层 | 边界 | 实现 |
|---|---|---|
| dsh server | 仅监听 `127.0.0.1`；**无 token 鉴权**（上游事实）：loopback 来源的 API 请求默认受信任，非回环来源需过 `/api` browser-trust 栅栏 | 固定 `--host 127.0.0.1`；本机其他进程可访问该端口属 loopback 固有特性，接受并在文档明示 |
| **`--trusted-host` 取舍（复审 3）** | 该参数语义：把**非回环来源**加入 `/api` browser-trust 栅栏白名单，服务**LAN/远程访问**场景 | **v1 不使用**——本方案不开放任何非回环访问（§1.3 非目标）；若未来多设备访问成为需求，需新增"远程访问"功能项并配套鉴权设计（browser-trust 只防浏览器来源混淆，不替代服务端鉴权；且 dsh 拒绝 `--host 0.0.0.0`，届时需上游支持或走代理方案），记录为演进路径而非 v1 范围 |
| Electron 渲染层 | 不信任任何远程内容（窗口只加载本地 server） | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；仅通过 preload `contextBridge` 暴露最小 IPC API；拦截新窗口/`window.open` 与外部导航 |
| 日志面板 | 只读展示，无文件系统操作暴露 | IPC 只提供读取环形缓冲与导出文件（导出走主进程保存对话框） |
| 引导下载（Slim） | 下载/安装需用户显式确认 | `npm i -g` 与 Node 解压前弹确认，明示目标路径与磁盘占用；镜像仅允许 https |

---

## 8. 目录结构（本项目新增代码）

```
dsh-desktop/
├── deepseek-harness/            # 子模块（只读，锁定/参考/审计面）
├── desktop/                     # ★ 桌面 App（全部新增）
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.ts         # 入口：单实例 → 起 server → 开窗口
│   │   │   ├── dsh-server.ts    # 子进程生命周期（spawn/预申请端口/健康探测/退出）
│   │   │   ├── runtime.ts       # 运行时解析（full/slim 双形态）
│   │   │   ├── tray.ts          # 托盘
│   │   │   ├── settings.ts      # 配置持久化（electron-store）
│   │   │   ├── log-store.ts     # 日志环形缓冲
│   │   │   ├── env-check.ts     # Slim 环境检测与引导（Slim 专属）
│   │   │   └── updater.ts       # electron-updater
│   │   ├── preload/             # contextBridge（最小 IPC 面）
│   │   └── renderer/            # 启动页 / 崩溃提示页 / 日志面板 / 设置页 / 引导页
│   ├── scripts/
│   │   ├── build-dsh.ps1        # 拉取 dsh npm 锁定包到 resources（D6）
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
| **M1** | 最小可用 | 脚手架 + dsh 产物获取（npm 锁定包拉取）+ spawn dsh → 窗口加载 Web UI | 安装/开发运行后双击，窗口出现并可使用 dsh Web UI |
| **M2** | 桌面能力 | 托盘、单实例、端口 fallback、日志面板、崩溃提示页 | 上述功能逐项可操作、可验证（含 §7.1 流程） |
| **M3** | 设置与引导 | 设置页、开机自启、Slim 环境检测与引导安装 | Slim 版在无 Node 机器上可完成引导并启动 |
| **M4** | 分发 | Full/Slim 双打包、自动更新、签名、发布流水线 | 两个安装包产出，更新链路可走通 |

### 9.1 量化验收指标（目标值待 M1/M3 实测校准）

| 指标 | 目标值 | 归属 |
|---|---|---|
| 冷启动 → 窗口可交互（环境就绪前提下） | **≤ 8s**（spawn + 健康探测 + Web UI 加载） | M1 |
| server 就绪判定耗时（健康探测首轮） | **≤ 3s** | M1 |
| 端口回退（EADDRINUSE → 新端口可用） | **≤ 5s** | M2 |
| server 崩溃 → 崩溃提示页可见 | **≤ 3s** | M2 |
| Slim 首启引导成功率（网络可达） | **≥ 90%**；单步可中断/可重试 | M3 |
| 升级下载中断恢复 | 下次启动自动续试 | M4 |

### 9.2 排期与关键路径（待补）

- 时间与人力估算需团队上下文（人数/投入），**暂记为待补**；M1 完成后按实测数据补排期。
- 已识别的关键路径：M1 的 dsh 产物获取（npm 锁定包，D6 已定）+ spawn 就绪判定；M3 的 Slim 引导。

---

## 10. 依赖条件与决策记录

### 10.1 需要项目方提供（延后项）

- [ ] **Windows 代码签名证书**（M4 签名步骤的前置条件；可用自签临时替代验证流程）；
- [ ] **自动更新分发渠道**（GitHub Releases / 自建服务器 / 其他）；
- [ ] **正式产品名**（暂定 `dsh-desktop`，影响安装包名/窗口标题/托盘）。

### 10.2 决策记录（含复审新增）

| 决策/问题 | 结论 | Owner | 日期 |
|---|---|---|---|
| Slim 版 dsh 缺失策略 | **首启 `npm i -g @deepseek-ai/dsh@<锁定版本>`（用户确认权限）**，不随包携带 | 项目方（D11） | 2026-08-17 |
| 数据目录默认值 | **`%APPDATA%\dsh-desktop`（userData）**，设置页可改 | 项目方（D12） | 2026-08-17 |
| 下载镜像支持 | **官方默认 + 设置页可配置镜像地址**（仅 https） | 项目方（D13） | 2026-08-17 |
| **（复审新增）Full 版 dsh 来源**：子模块构建 vs npm 锁定包 | **npm 锁定包 `@deepseek-ai/dsh@0.1.0-rc.6`（双版本统一）** ✅ | 项目方（D6） | 2026-08-17 |
| **（复审新增）Slim/Full dsh 版本一致性** | 已统一：双版本均锁定 npm `0.1.0-rc.6`；升级走 §5.2 流程 | 项目方 | 2026-08-17 |

### 10.3 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh `build:web` 依赖完整 workspace 安装（网络/磁盘） | 构建失败 | **已消除**（D6：改用 npm 锁定包，无 monorepo 构建） |
| pnpm 版本不符（本机 11.4 vs 要求 11.7） | 安装/构建告警或失败 | **已消除**（D6：无 pnpm 构建路径）；子模块仅作参考不构建 |
| dsh 生产依赖规模大 → 首启下载/安装包体积超预期 | 体验差 | M1 实测回填 §6.2 体积表；npm 链实测约 ≤100MB（估算） |
| **（复审 1）`--port 0` 端口盲区** | 无法获知实际端口 | **已消除**：改用主进程预申请空闲端口（§5.3） |
| **（复审 2）Slim Web UI 供给** | Slim 装全局 dsh 后无 UI | **已排除**：npm 链自带 `dsh-web-frontend/dist`（registry 核验），M1 实测确认 |
| **（复审 2）双版本 dsh 版本不一致**（rc.5 vs rc.6） | 行为差异、排障混乱 | **已消除**（D6：双版本统一 npm `0.1.0-rc.6`） |
| npm 锁定包升级时上游破坏性变更 | 双版本行为突变 | 升级前在子模块 review 对应变更（§5.1），锁定版本升级走评审 |
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
- dsh Web UI 供给：`deepseek-harness/packages/bundle/web-app/src/index.ts`（`resolveDistIndex`、`printUrl`）
- dsh 信任栅栏：`deepseek-harness/packages/client/connection/src/api-request-trust.ts`
- npm 包核验：`registry.npmjs.org/@deepseek-ai/dsh-web-frontend`（4.41MB，含 dist）
- Electron 版本/Node 对应：[releases.electronjs.org](https://releases.electronjs.org/)
