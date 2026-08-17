# dsh-desktop（desktop/）

DeepSeek Harness 桌面客户端（Electron + TypeScript）。完整设计见 [../docs/DESIGN.md](../docs/DESIGN.md)。

## 结构

```
src/main/      Electron 主进程（server 生命周期 / 托盘 / 设置 / 日志 / 引导 / 更新）
src/renderer/  UI（启动页、日志、设置、引导、崩溃提示）
preload/       contextBridge（最小 IPC 面）
scripts/       build / prepare-dsh / fetch-node / smoke / make-icon
build/         electron-builder 资源（icon）
resources/     运行时产物（dev-dsh / node / dsh，均不入库）
```

## 开发

要求：Node ≥ 22.19。

```sh
npm install              # 安装依赖（含 Electron）
npm run make:icon        # 生成图标（首次）
node scripts/prepare-dsh.mjs   # 拉取 dsh npm 锁定包到 resources/dev-dsh（开发用）
npm run build            # tsc + 静态资源拷贝到 out/
npm run dev              # 启动 Electron（dev 形态：系统 node + resources/dev-dsh 的 dsh）
npm run smoke            # 无 GUI 冒烟：验证 dsh 包能启动并托管 Web UI
```

> dev 形态的 dsh server 使用系统 `node` 启动 `resources/dev-dsh` 中的 dsh；
> 如本机已有全局 dsh，也可直接使用（Slim 形态逻辑）。

## 双版本打包

```sh
# Full（捆绑官方 Node.exe + dsh 产物）
node scripts/prepare-dsh.mjs          # → resources/dsh
node scripts/fetch-node.mjs           # → resources/node
npm run pack:full                     # → release/full/

# Slim（最小安装包，首启引导安装环境）
npm run pack:slim                     # → release/slim/
```

产物：NSIS 安装包（`dsh-desktop-{full|slim}-{version}-setup.exe`）+ 自动更新 feed（`latest.yml`）。

## 发布（CI）

- **CI**（`.github/workflows/ci.yml`）：push/PR 时 typecheck + build + dsh 冒烟。
- **Release**（`.github/workflows/release.yml`）：打 `v*` tag 或手动触发 → 构建双版本 → 发布到 GitHub Release（含更新源）。
- **签名**：在仓库 Secrets 配置 `CSC_LINK` + `CSC_KEY_PASSWORD` 即启用 Windows 代码签名；未配置则产出未签名安装包。

```sh
git tag v0.1.0 && git push origin v0.1.0   # 触发发布
```

## dsh 版本锁定

- 锁定版本见 `config.json`（`dshVersion` / `nodeVersion`）。
- 升级：`npm view @deepseek-ai/dsh versions` 确认 → 更新 `config.json` → 双版本同步。
- 子模块 `../deepseek-harness` 仅作参考/审计，**零修改**（CI 校验）。
