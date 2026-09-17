# DSH PC Manager

> 中文：基于 DeepSeek Harness 的 Windows AI 电脑管家，先只读扫描，再由 Agent 和用户共同决定是否清理。
>
> English: A Windows AI computer manager powered by DeepSeek Harness. Scan read-only first, then let an Agent and the user decide what may be cleaned.

<p align="center">
  <img src="docs/screenshots/home.png" width="49%" alt="DSH PC Manager home dashboard" />
  <img src="docs/screenshots/scope-picker.png" width="49%" alt="DSH PC Manager scan scope picker" />
</p>
<p align="center">
  <img src="docs/screenshots/settings-model.png" width="49%" alt="DSH PC Manager model service settings" />
  <img src="docs/screenshots/settings-about.png" width="49%" alt="DSH PC Manager about page" />
</p>


[中文](#中文) · [English](#english)

## 中文

### 项目简介

DSH PC Manager 是一个面向 Windows 10/11 的独立桌面应用。它将硬盘清理、病毒关联分析、Token 用量和 Agent 对话集中在一个 Electron 窗口中；扫描范围由用户明确选择，清理动作必须经过多重确认。

项目使用 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 作为底层 Agent 运行时。本项目不是 DeepSeek 官方产品。

### 核心能力

- 硬盘清理：分析缓存、日志、转储、构建产物、陈旧安装包和应用残留等空间风险。
- 病毒关联分析：关联进程、数字签名、网络连接、防火墙、Defender、启动项、服务、计划任务和常见植入位置。
- 可选扫描范围：支持本地磁盘和用户添加的自定义目录，不默认扫描所有磁盘。
- Agent 工作流：规划 Agent 生成可见计划；只读扫描 Agent 收集证据；独立审核 Agent 对清理目标逐项给出 `allow / deny / manual`。
- 安全清理：只有用户勾选、确认且通过独立审核的项目，才会进入新的清理 Agent 会话；文件默认优先移动到隔离区，保留恢复路径。
- 风险清单：按严重度筛选、查看证据，并逐项选择采用 AI 建议、忽略、隔离或手动方案。
- 对话助手：支持 GFM Markdown、表格、列表、代码块和 `@` 本机文件/目录补全；引用只授予只读查看权限。
- 本地控制：Token 本次/累计用量、操作历史、模型思考等级、自定义 Agent 预设、自动保存和 75%–125% 界面缩放。
- Windows 集成：病毒、整盘或系统目录扫描会提示 Windows 官方 UAC；安装器默认创建桌面快捷方式。

### 安全边界

1. 扫描和审核会话均运行在 DSH `read-only` 文件沙箱中，扫描阶段禁止写入。
2. 清理需要经过“用户勾选并确认 → 独立审核 Agent → 新清理 Agent 会话”。
3. 清理提示词禁止通配符扩大范围、未知目录递归删除、批量 ACL 修改，以及关闭 Defender、UAC 或防火墙等高风险行为。
4. 结构化 Agent 输出使用严格解析；缺失的审核决定按 `manual` 处理，缺失的执行结果按失败处理。
5. API Key 使用 Electron `safeStorage` 加密保存在本机，遥测默认关闭。

AI 研判不能替代企业级杀毒引擎。涉及系统文件、驱动、关键服务或不确定项目时，请人工复核；病毒分析结果也不应视为恶意软件定论。

### 快速开始

环境要求：Windows 10/11、Node.js 22.12+、npm。

```powershell
npm install
npm start
```

首次启动后，打开“设置 → 模型服务”，填写 DeepSeek API Key、Base URL 和模型 ID。默认配置为：

```text
Provider: deepseek-official
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

不要把真实 API Key 写入源码、`.env`、Issue 或提交记录。

### 测试与构建

```powershell
npm run typecheck
npm test
npm run test:settings
npm run test:integration
npm run test:hidden-window
npm run test:shortcut
npm run build
```

集成测试会在随机临时目录创建模拟环境，验证 DSH 只读沙箱、风险解析、Token 统计、规划/审核/清理链路和隐藏终端窗口行为。

生成 Windows v1.0 安装包：

```powershell
npm run package
```

安装器会输出到 `release/DSH-PC-Manager-1.0.0-Setup.exe`。`release/`、`win-unpacked/`、依赖和构建缓存均已加入 `.gitignore`；安装包应作为 GitHub Release 附件上传，不要提交到源码仓库。

### GitHub 发布建议

- 仓库名：`dsh-pc-manager`
- Release 标题：`DSH PC Manager v1.0`
- Tag：`v1.0`
- Description：`Windows AI PC manager powered by DeepSeek Harness — scoped read-only scanning, safe cleanup review, and privacy-first desktop controls.`
- Topics：`electron`、`react`、`typescript`、`vite`、`windows`、`desktop-app`、`ai`、`deepseek`、`deepseek-harness`、`computer-manager`、`disk-cleaner`、`virus-scanner`、`privacy`、`cybersecurity`

### 目录结构

```text
src/main          Electron 主进程、DSH 运行时和安全控制
src/renderer      React 桌面界面
src/shared        主进程与界面共享类型/协议
resources/dsh     DSH PC Manager 专用提示词补丁
docs/screenshots  README 展示截图（纳入源码仓库）
tests             单元测试与 DSH 隔离集成测试
scripts           构建补丁、图标和 Electron 冒烟测试
_local            本机 Release/参考资料（已忽略）
```

## English

### Overview

DSH PC Manager is a standalone Windows 10/11 desktop application built with Electron, React, TypeScript and DeepSeek Harness. It brings scoped disk cleanup, virus-related system analysis, token usage and Agent assistance into one desktop window.

The scan scope is explicit, scan sessions are read-only, and cleanup is gated by user confirmation plus an independent review Agent. DeepSeek Harness is the underlying Agent runtime; this project is not an official DeepSeek product.

### Features

- Disk cleanup analysis for caches, logs, dumps, build artifacts, stale installers and application leftovers.
- Virus-related analysis across processes, signatures, network connections, firewall, Defender, startup entries, services, scheduled tasks and common persistence locations.
- User-selected local disks and custom directories; all disks are not scanned by default.
- A visible planning Agent, read-only scan Agent and independent review Agent with `allow / deny / manual` decisions.
- Safe cleanup flow: user selection and confirmation, independent review, then a new cleanup session; files are quarantined by default for reversibility.
- Severity filters, evidence details and per-item AI, ignore, quarantine or manual handling choices.
- GFM Markdown chat, tables, lists, code blocks and read-only `@` file/directory references.
- Local token usage and operation history, reasoning levels, custom Agent presets, autosave and 75%–125% UI scaling.
- Windows UAC guidance for privileged scans and a desktop shortcut created by the installer.

### Safety model

- Scan and review sessions use the DSH `read-only` file sandbox; scanning cannot write to the selected scope.
- Cleanup requires user confirmation, an independent review Agent and a separate cleanup Agent session.
- Cleanup instructions reject wildcard scope expansion, unknown recursive deletion, bulk ACL changes and attempts to disable Defender, UAC or the firewall.
- Structured Agent responses are strictly parsed; missing review decisions become `manual`, and missing execution results become failures.
- API keys are encrypted with Electron `safeStorage` and telemetry is disabled by default.

AI analysis is not a replacement for an enterprise antivirus engine. Review system files, drivers, critical services and uncertain findings manually; virus-analysis output is not a definitive malware verdict.

### Quick start

Requirements: Windows 10/11, Node.js 22.12+ and npm.

```powershell
npm install
npm start
```

Open `Settings → Model Service` after the first launch and enter your DeepSeek API key, base URL and model ID. The default values are:

```text
Provider: deepseek-official
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

Never commit a real API key to source code, `.env`, issues or Git history.

### Test and package

```powershell
npm run typecheck
npm test
npm run build
npm run package
```

The Windows v1.0 installer is written to `release/DSH-PC-Manager-1.0.0-Setup.exe`. The `release/` directory, unpacked build, dependencies and build caches are ignored by Git. Upload the installer as a GitHub Release asset instead of committing it to the source repository.

### Repository metadata

- Suggested repository name: `dsh-pc-manager`
- Suggested Release title: `DSH PC Manager v1.0`
- Suggested tag: `v1.0`

Suggested topics: `electron`, `react`, `typescript`, `vite`, `windows`, `desktop-app`, `ai`, `deepseek`, `deepseek-harness`, `computer-manager`, `disk-cleaner`, `virus-scanner`, `privacy`, `cybersecurity`.

### License

This project is released under the MIT License. See [`LICENSE`](LICENSE).
