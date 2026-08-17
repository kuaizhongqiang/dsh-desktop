# dsh-desktop

DeepSeek Harness（dsh）的桌面客户端：以 Electron 桌面壳内嵌 dsh Web UI，本地管理 dsh server 子进程，提供托盘、单实例、日志面板、设置页等桌面体验。

> 📄 完整方案见 [docs/DESIGN.md](docs/DESIGN.md)

## 项目结构

- `deepseek-harness/` — dsh 上游（git submodule，**只读，零修改**，仅构建使用）
- `desktop/` — 桌面 App（Electron + TypeScript，本项目全部新增代码）
- `docs/DESIGN.md` — 设计文档（paper）

## 双版本发布模型

| 版本 | 说明 |
|---|---|
| **Full 版** | 全量自包含：捆绑官方 Node.exe + dsh 构建产物，安装即用，零依赖拉取 |
| **Slim 版** | 最小安装包：首启检测系统环境（Node ≥22.19 / dsh），缺失时引导安装或自动下载 |

## 开发指南

（待 M1 落地后补充：环境要求、构建命令、开发运行、打包发布）

## 里程碑与任务

见 [GitHub Milestones](https://github.com/kuaizhongqiang/dsh-desktop/milestones)（M1 最小可用 → M4 分发与发布），任务按里程碑拆分为 Issues。
