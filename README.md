# dsh-desktop

DeepSeek Harness（dsh）的 Windows 桌面客户端：以 Electron 桌面壳内嵌 dsh Web UI，本地管理 dsh server 子进程，提供托盘常驻、单实例、端口冲突自动回退、日志面板、设置页等桌面体验。

> 📄 完整方案见 [docs/DESIGN.md](docs/DESIGN.md)（v0.4，经评审修订）
> 📦 最新发布：[GitHub Releases](https://github.com/kuaizhongqiang/dsh-desktop/releases)

## 功能特性

- **内嵌 dsh Web UI**：App 自动拉起 dsh server（`dsh --profile web`）并在窗口内加载其 Web UI，dsh 上游零修改
- **自管理 server 生命周期**：预申请空闲端口、健康探测就绪判定、优雅退出 + 进程树清理、端口冲突自动回退
- **桌面能力**：系统托盘（最小化到托盘）、单实例锁、日志面板（环形缓冲 + 导出）、崩溃提示页
- **设置页**：端口、开机自启、数据目录（`DSH_HOME`）、下载镜像、托盘行为
- **自动更新**：electron-updater（Full/Slim 分 channel 更新源）

## 双版本发布模型

| 版本 | 目标用户 | 说明 | 安装包 |
|---|---|---|---|
| **Full 版** | 轻度用户 | 全量自包含：捆绑官方 Node.js + dsh（npm 锁定包），安装即用，零依赖拉取 | `dsh-desktop-full-0.1.0-setup.exe`（~168MB） |
| **Slim 版** | 开发者 | 最小安装包：首启检测系统环境（Node ≥ 22.19 / dsh），缺失时引导下载 Node / 全局安装 dsh | `dsh-desktop-slim-0.1.0-setup.exe`（~89MB） |

## 里程碑状态

| 里程碑 | 状态 |
|---|---|
| M1 最小可用 | ✅ 完成 |
| M2 桌面能力 | ✅ 完成 |
| M3 设置与引导 | ✅ 完成 |
| M4 分发与发布 | ✅ 完成（v0.1.0 已发布） |

## 项目结构

- `deepseek-harness/` — dsh 上游（git submodule，**只读，零修改**；作为版本锁定/参考/审计面）
- `desktop/` — 桌面 App（Electron + TypeScript，全部为新增代码，含开发指南见 [desktop/README.md](desktop/README.md)）
- `docs/DESIGN.md` — 设计文档（paper）；`docs/DESIGN-REVIEW.md` — 评审意见
- `.github/workflows/` — CI（typecheck/build/冒烟）与 Release（双版本打包 + 发布）工作流

## 快速开始（开发）

要求：Node ≥ 22.19（本机建议 24.x）。

```sh
cd desktop
npm install
npm run make:icon            # 生成图标（首次）
node scripts/prepare-dsh.mjs # 拉取 dsh npm 锁定包（resources/dev-dsh，开发用）
npm run build                # tsc + 静态资源
npm run dev                  # 启动 Electron（dev 形态：系统 node + 本地 dsh）
npm run smoke                # 无 GUI 冒烟：验证 dsh 可启动并托管 Web UI
```

## 打包与发布

```sh
# Full（捆绑 Node.exe + dsh 产物）
node scripts/prepare-dsh.mjs
node scripts/fetch-node.mjs
npm run pack:full            # → release/full/

# Slim（最小安装包）
npm run pack:slim            # → release/slim/

# 发布（打 tag 触发 GitHub Actions）
git tag v0.1.1 && git push origin v0.1.1
```

CI 自动执行：typecheck → build → dsh 冒烟 → 双版本 NSIS 打包 → 发布到 GitHub Release（含分 channel 更新源 `full.yml`/`slim.yml`）。配置仓库 Secrets `CSC_LINK` + `CSC_KEY_PASSWORD` 即启用 Windows 代码签名。

## 相关链接

- dsh 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 设计文档：[docs/DESIGN.md](docs/DESIGN.md)
- 发布：[GitHub Releases](https://github.com/kuaizhongqiang/dsh-desktop/releases)
