# dsh-desktop 设计文档（Paper）

> 状态：草案 v0.1（待评审）
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

1. 提供原生桌面外壳（安装包、托盘、自动更新、签名），用户无需接触命令行即可使用 dsh；
2. 以**双版本发布模型**交付：Slim 版（依赖外部环境）与 Full 版（全量自包含）；
3. 保持 dsh 子模块**完全不变**，本项目所有代码均为新增。

### 1.3 非目标（v1 不做）

- 不修改、不 fork dsh 源码；
- 不重做 dsh Web UI（纯内嵌，标准窗口壳）；
- 不做健康监控/进程自动重启（仅记录崩溃日志）；
- 不做 macOS/Linux 支持（Windows 优先，架构上预留跨平台空间）。

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
│  │ (Node 运行时)   │  stdout 解析端口 │ dsh --profile web  │ │
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
2. 主进程监听子进程 stdout，解析实际监听端口（默认 3080；`--port 0` 时由 OS 分配，需从输出读取）；
3. 端口就绪后创建 BrowserWindow，加载 `http://127.0.0.1:<port>`；
4. App 退出时向子进程发送优雅退出信号，超时后强制终止并清理进程树。

---

## 4. 技术决策记录

> 决策项均经需求确认（2026-06 与项目方三轮问答），标注 ✅ 为已确认。

| # | 决策项 | 结论 | 依据/备注 |
|---|---|---|---|
| D1 | 桌面框架 | **Electron**（TypeScript）✅ | 与 dsh 同为 Node/TS 生态；可 spawn 子进程；打包链路成熟 |
| D2 | server 连接方式 | **内置启动（本地 spawn）** ✅ | App 管理 dsh server 全生命周期；不做远程连接（v1） |
| D3 | UI 策略 | **内嵌 dsh 现有 Web UI** ✅ | dsh 零修改；标准窗口壳包裹 |
| D4 | 目标平台 | **Windows 优先** ✅ | 架构预留跨平台 |
| D5 | 运行时策略 | **双版本** ✅ | Full 版捆绑官方 Node.exe；Slim 版首启引导安装（见 §6） |
| D6 | dsh 来源 | **子模块原样构建** ✅ | 锁定 commit `47f9438`；`pnpm install && pnpm build && pnpm build:web` |
| D7 | 代码形态 | **同一套代码，双打包配置** ✅ | electron-builder 两套配置产物 |
| D8 | 分发 | **NSIS 安装包 + electron-updater + 代码签名** ✅ | 签名证书与更新源待提供（见 §10） |
| D9 | 窗口外观 | **标准窗口壳** ✅ | 不做无边框自定义标题栏 |

### 4.1 已验证的技术事实（2026-06 核实）

| 事实 | 值 | 来源 |
|---|---|---|
| dsh CLI 包 | npm `@deepseek-ai/dsh`，latest `0.1.0-rc.6`；bin `dsh` | npm registry |
| 子模块版本 | 根包 `0.1.0-rc.5`，commit `47f943859b`（master HEAD） | 本仓库子模块 |
| Node 要求 | `^22.19.0 \|\| >=24.0.0` | dsh 根 package.json `engines` |
| pnpm 要求 | `pnpm@11.7.0` | dsh 根 package.json `packageManager` |
| 启动命令 | `dsh --profile web [--host <h>] [--port <p>] [--trusted-host ...]` | dsh `apps/cli/src/args.ts` |
| 默认监听 | `127.0.0.1:3080` | dsh `cordis.patch.yml`（webStartup 默认） |
| 端口 0 语义 | `--port 0` 由 OS 分配空闲端口，需从 stdout 解析 | dsh `web-app/startup.ts` |
| 安全约束 | `--host 0.0.0.0` 被 dsh 显式拒绝（防 RCE 暴露到网络） | dsh `web-app/startup.ts` |
| 原生依赖 | **无**（无 binding.gyp/.node/node-gyp）；SQLite 用内置 `node:sqlite` | 子模块扫描 |
| Web UI 产物 | `apps/web` → dist，由 `dsh-host-frontend-static` 服务；**workspace 构建产物，npm 发布链不保证自带** | dsh `frontend-static/index.ts` |
| Electron 内置 Node | Electron 39.x = Node 22.22.1（满足 dsh engines） | releases.electronjs.org |
| 本机构建环境 | Node v24.14.0 ✅；pnpm 11.4.0（需对齐 11.7）；Windows 10 19045 | 本机检测 |

---

## 5. dsh 集成方案（零修改约束）

### 5.1 引入方式

- `deepseek-harness/` 以 **git submodule** 引入，锁定 commit；
- 上游更新时通过**更新 submodule 指针**同步（`git submodule update --remote` 或手动），**绝不直接修改子模块内文件**；
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

### 5.3 dsh server 启动参数

```text
dsh --profile web --host 127.0.0.1 --port <port>
```

- `--host` 固定 `127.0.0.1`（dsh 拒绝 `0.0.0.0`，本地回环符合桌面 App 定位）；
- `--port`：默认取设置页配置（默认 `3080`）；检测到端口占用（EADDRINUSE / 健康探测失败）时回退 `--port 0`（OS 分配）并在 UI/日志提示实际端口；
- server 就绪判定：解析 stdout 中的 URL 行（`printUrl: true`）或对 `http://127.0.0.1:<port>/` 做健康探测。

---

## 6. 双版本发布模型

> 同一套源码，两套 electron-builder 配置，产出两个安装包。

| 维度 | **Slim 版（依赖版）** | **Full 版（自包含版）** |
|---|---|---|
| 定位 | 面向已有 Node/dsh 环境的开发者 | 面向最终用户，安装即用 |
| 安装包 | 最小（不含 Node、不含 dsh 产物） | 大（捆绑官方 Node.exe + dsh 构建产物） |
| 首启行为 | 环境检测：Node ≥22.19 是否存在、dsh 可用性 | 直接启动，零检测 |
| 环境缺失处理 | **引导安装**：指引/自动下载 Node 与 dsh（§6.3） | 不适用 |
| 子进程启动 | 系统 `node` + 随包 dsh 代码（若随包）或全局 dsh | 捆绑 `node.exe` + 随包 dsh 产物 |
| 自动更新/签名 | 是 | 是 |

### 6.1 共用代码

主进程/渲染层/托盘/日志/设置/更新逻辑**完全共用**；差异收敛在：

- 打包配置（`electron-builder` 的 extraResources / 文件包含清单）；
- 启动器选择：`resolveRuntime()` 依据发行形态（编译期注入 `APP_VARIANT=full|slim`）与运行环境返回 node 路径与 dsh 入口；
- 环境检查与引导（Slim 专属模块，Full 版编译排除）。

### 6.2 Full 版打包输入

- 官方 Node 二进制（Windows x64，22.22.x LTS 线，满足 engines）——`scripts/fetch-node.ps1` 下载，校验 SHA256；
- dsh 构建产物（§5.2）与生产依赖；
- 均放入 `extraResources/`（asar 外），子进程直接以真实文件路径启动。

### 6.3 Slim 版引导流程（首启）

1. 探测 `node`：`node --version` ≥ 22.19？
2. 探测 dsh：`dsh --version` 可用？或随包 dsh 代码存在？
3. 缺失 → 引导页（渲染层）：
   - Node 缺失：提供下载指引（nodejs.org）或**自动下载**（后台下载 + 校验 + 解压到用户数据目录）；
   - dsh 缺失：自动 `npm install -g @deepseek-ai/dsh@<锁定版本>` 或下载锁定版本 tarball；
4. 完成后回跳步骤 1 校验，通过即进入正常启动流程。

> 自动下载涉及外部网络与写入用户目录，需在设置页提供开关；下载源（nodejs.org / npm registry）在国内网络可能受限，需支持镜像配置。

---

## 7. 功能规格（v1）

| 功能 | 说明 | 实现要点 |
|---|---|---|
| **主窗口** | 标准窗口壳内嵌 dsh Web UI | `BrowserWindow` + `loadURL(http://127.0.0.1:<port>)`；就绪前显示启动页 |
| **系统托盘** | 关闭窗口最小化到托盘；托盘菜单：显示/隐藏、重启 server、打开日志、退出 | `Tray` + 图标；`close` 拦截 + `app.quit` 语义 |
| **单实例锁** | 二次启动聚焦已有窗口 | `app.requestSingleInstanceLock()` + `second-instance` 事件 |
| **端口冲突处理** | 配置端口被占 → 自动回退 OS 分配端口并提示 | 健康探测 + `--port 0` 重试；日志与设置页展示实际端口 |
| **日志面板** | 查看 dsh server 的 stdout/stderr | 环形缓冲（主进程）→ IPC 推送 → 渲染层面板；含导出 |
| **设置页** | 端口、开机自启、数据目录、关于 | `electron-store` 持久化；`app.setLoginItemSettings` |
| **优雅退出** | 退出时先停 server | SIGTERM → 等待 → 超时 kill；清理子进程树（Windows `taskkill /T` 兜底） |

---

## 8. 目录结构（本项目新增代码）

```
dsh-desktop/
├── deepseek-harness/            # 子模块（只读，仅构建）
├── desktop/                     # ★ 桌面 App（全部新增）
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.ts         # 入口：单实例 → 起 server → 开窗口
│   │   │   ├── dsh-server.ts    # 子进程生命周期（spawn/端口解析/退出）
│   │   │   ├── runtime.ts       # 运行时解析（full/slim 双形态）
│   │   │   ├── tray.ts          # 托盘
│   │   │   ├── settings.ts      # 配置持久化
│   │   │   ├── log-store.ts     # 日志环形缓冲
│   │   │   ├── env-check.ts     # Slim 环境检测与引导（Slim 专属）
│   │   │   └── updater.ts       # electron-updater
│   │   ├── preload/             # contextBridge
│   │   └── renderer/            # 启动页 / 日志面板 / 设置页 / 引导页
│   ├── scripts/
│   │   ├── build-dsh.ps1        # 构建子模块（原样）
│   │   ├── fetch-node.ps1       # 下载官方 Node.exe（Full）
│   │   └── pack.ps1             # 双版本打包入口
│   ├── build/                   # electron-builder 双配置（full/slim）
│   └── package.json
├── docs/DESIGN.md               # 本文档
├── package.json / pnpm-workspace.yaml（根，可选）
└── README.md
```

> 说明：`desktop/` 为独立 npm 工程，与子模块的 pnpm workspace 相互隔离（嵌套 workspace 不互相引用），避免污染 dsh 的依赖树。

---

## 9. 里程碑规划

| 里程碑 | 名称 | 核心交付 | 验收标准 |
|---|---|---|---|
| **M1** | 最小可用 | 脚手架 + dsh 构建脚本 + spawn dsh → 窗口加载 Web UI | 安装/开发运行后双击，窗口出现并可使用 dsh Web UI |
| **M2** | 桌面能力 | 托盘、单实例、端口 fallback、日志面板、异常退出记录 | 上述功能逐项可操作、可验证 |
| **M3** | 设置与引导 | 设置页、开机自启、Slim 环境检测与引导下载 | Slim 版在无 Node 机器上可完成引导并启动 |
| **M4** | 分发 | Full/Slim 双打包、自动更新、签名、发布流水线 | 两个安装包产出，更新链路可走通 |

对应 GitHub milestones 与 issues 见仓库（每个里程碑含验收清单 issue）。

---

## 10. 依赖条件与开放问题

### 10.1 需要项目方提供

- [ ] **Windows 代码签名证书**（M4 签名步骤的前置条件；可用自签临时替代验证流程）；
- [ ] **自动更新分发渠道**（GitHub Releases / 自建服务器 / 其他）；
- [ ] **正式产品名**（暂定 `dsh-desktop`，影响安装包名/窗口标题/托盘）。

### 10.2 开放问题（待评审讨论）

- 数据目录位置：默认 `app.getPath('userData')` vs 允许用户自定义（设置页已列，需定默认值策略）；
- Slim 版 dsh 缺失时的策略：随包携带 dsh 代码（仅依赖系统 Node）vs 纯引导安装全局 dsh——影响安装包体积与体验，倾向**随包携带 dsh 代码 + 系统 Node**，待确认；
- 自动下载 Node 的镜像支持（国内网络），默认直连 nodejs.org。

### 10.3 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh `build:web` 依赖完整 workspace 安装（网络/磁盘） | 构建失败 | CI/脚本固化命令；构建产物缓存；锁定 pnpm 版本 |
| pnpm 版本不符（本机 11.4 vs 要求 11.7） | 安装/构建告警或失败 | `corepack` 对齐；脚本内校验 |
| 端口解析依赖 dsh 输出格式 | M1 阻塞 | 以健康探测兜底（轮询 `/` 返回 200）；锁定 dsh commit 避免输出漂移 |
| Windows 下子进程清理不彻底（僵尸进程） | 端口/资源残留 | `taskkill /T /F` 兜底 + 启动前端口预检 |
| Slim 引导下载源网络受限 | 首启体验差 | 镜像配置 + 手动指引兜底 |
| dsh 上游变更（submodule 指针漂移） | 行为不一致 | 锁定 commit；升级走评审 |
| 签名证书缺失 | M4 阻塞 | 提前申请；未到位前用自签验证流程 |

---

## 11. 参考

- dsh 仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（子模块只读）
- dsh 架构文档：`deepseek-harness/docs/architecture.md`、`docs/AGENTS.md`
- dsh CLI 参数：`deepseek-harness/apps/cli/src/args.ts`、`packages/bundle/web-app/src/startup.ts`
- Web server 配置：`deepseek-harness/packages/bundle/web-app/cordis.patch.yml`
- Electron 版本/Node 对应：[releases.electronjs.org](https://releases.electronjs.org/)
