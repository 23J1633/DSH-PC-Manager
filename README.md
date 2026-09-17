# DSH PC Manager

基于 DeepSeek Harness 的 Windows AI 电脑管家。应用使用 Electron 提供独立桌面窗口，扫描、审核与清理能力由 DSH Agent 驱动，界面不依赖外部浏览器。

English summary: DSH PC Manager is a Windows desktop AI computer manager built with Electron, React, TypeScript and DeepSeek Harness. It performs scoped read-only scans and requires explicit confirmation plus an independent Agent review before cleanup.

## 已实现

- 图形化主页面：硬盘清理、病毒扫描、实时 Token 消耗三张主卡片。
- 可选扫描范围：支持选择一个或多个本地磁盘，也可通过系统目录选择器添加任意目录；不会默认扫描所有磁盘。
- 只读扫描：扫描 Agent 固定运行在 DSH `read-only` 文件沙箱中。
- 硬盘风险分析：缓存、日志、转储、构建产物、陈旧安装包和应用残留等。
- 病毒关联分析：进程、签名、连接、防火墙、Defender、启动项、服务、计划任务、常见植入位置等。
- 双 Agent 清理链路：独立只读审核 Agent 逐项给出 `allow / deny / manual`；只有审核放行项才会进入新的清理 Agent 会话。
- 可逆优先：文件默认优先移动到应用隔离区，清理结果保留恢复路径和复查建议。
- 风险清单：按严重度筛选、展开证据，并可逐项选择“采用 AI 建议 / 忽略 / 隔离 / 手动方案”；手动方案会先经过独立审核 Agent。
- 扫描前由规划 Agent 生成可见计划，进度按实际计划步骤与工具调用推进，不再用固定的 90% 假进度。
- 风险结果默认按“严重 → 高风险 → 需确认 → 低风险”排序；成功清理或隔离的项目会从当前清单移除。
- 对话区支持一键放大、GFM Markdown（表格、列表、代码块等）和 `@` 本机文件/目录补全；引用只授予只读查看权限。
- Token 卡片同时显示本次任务与本机累计消耗；本机操作历史可展开查看每条扫描发现、证据、AI 建议、用户处理方式、审核结论与实际执行结果。
- 保留模型选择和清扫 Agent 预设；支持添加自定义预设。
- 模型思考等级支持关闭、低、高、最高四档，并通过 DSH 原生 `reasoningEffort` 应用于扫描、审核、清理和对话。
- 设置全部自动保存，支持完整明暗主题和 75%–125% 相对界面缩放；显示的 100% 对应原 125% 物理缩放。
- 病毒扫描、整盘或系统目录扫描在未提权时会提示通过 Windows 官方 UAC 以管理员身份重启，也可明确选择受限扫描。
- 模型连接测试直接发送一次最小请求，最长等待 12 秒。
- DSH 及其 PowerShell 子进程使用 Windows 隐藏窗口标志，扫描期间不会反复弹出终端窗口。
- API Key 使用 Electron `safeStorage` 加密保存，遥测默认关闭。
- 安装器默认创建桌面快捷方式；设置页也可随时重新创建快捷入口。

## 安全边界

1. 扫描会话与审核会话均使用 DSH `read-only` 权限；文件系统写入会被运行时沙箱拦截。
2. 清理必须经过“用户勾选并确认 → 独立审核 Agent → 新清理 Agent 会话”三道门槛。
3. 清理提示词禁止通配符扩大范围、未知目录递归删除、批量 ACL 修改、关闭 Defender/UAC/防火墙等高风险行为。
4. Agent 的结构化输出使用严格解析器；缺失的审核决定按 `manual` 处理，缺失的执行结果按失败处理。
5. 病毒扫描可读取全局运行态，但文件递归、哈希和落点排查仍受用户所选磁盘或目录约束。

AI 研判不能替代企业级杀毒引擎。涉及系统文件、驱动、关键服务或不确定项目时，审核 Agent 会拒绝或要求人工处理。

## 开发运行

环境：Windows 10/11、Node.js 22、npm。

```powershell
npm install
npm start
```

首次进入后，在“设置 → 模型服务”中填写 DeepSeek API Key、Base URL 和模型 ID。默认配置为：

- Provider：`deepseek-official`
- Base URL：`https://api.deepseek.com`
- Model：`deepseek-v4-flash`

## 测试

```powershell
npm run typecheck
npm test
npm run test:settings
npm run test:integration
npm run test:hidden-window
npm run test:shortcut
npm run build
```

集成测试会在系统临时目录创建一个小型模拟环境，启动真实 DSH SDK 进程并连接本地假模型。它会验证：

- PowerShell 只读目录检查可以返回模拟文件；
- 写文件请求被 DSH `read-only` 沙箱拒绝；
- 风险结果能被严格解析；
- Token 使用事件可以累计；
- 规划 Agent 在扫描工具调用前返回计划，界面进度绑定计划步骤；
- 独立审核 Agent 在只读会话中核验目标，目标在审核阶段保持不变；
- 审核放行后才创建新的清理会话，并把模拟文件精确移动到临时隔离区；
- 测试目标仅位于随机临时目录，结束后精确删除。
- 以 20ms 间隔监控真实集成测试期间的新窗口，确保没有 PowerShell、cmd、conhost 或 OpenConsole 终端弹窗。

设置测试覆盖主题、缩放、模型、扫描选项、自定义预设、隔离保留期、遥测、凭据加密、Token 与并发自动保存。UI 冒烟测试使用 `DSH_PC_MANAGER_SMOKE_SCREENSHOT` 环境变量启动真实 Electron 窗口并保存截图；`DSH_PC_MANAGER_SMOKE_CLICK` 或 `DSH_PC_MANAGER_SMOKE_ACTIONS` 可在截图前执行界面动作。

## 打包与快捷入口

```powershell
npm run package
```

安装包输出到本机 `release` 目录。该目录已经列入 `.gitignore`，不会提交到源码仓库；发布时请将安装包作为 GitHub Release 附件上传，而不是把整个 `release` 目录提交进 Git。NSIS 安装器默认创建名为 `DSH PC Manager` 的桌面快捷方式；应用设置页中的“创建桌面快捷方式”可直接生成同名入口。

不安装直接测试时，运行：

```powershell
& '.\release\win-unpacked\DSH PC Manager.exe'
```

也可以从源码运行 `npm start`。两种方式都不会执行安装程序；`win-unpacked` 是已打包的免安装版本。

## 目录说明

- `src/main`：Electron 主进程、DSH JSON-RPC 运行时、操作控制器、安全设置。
- `src/renderer`：独立桌面 UI。
- `src/shared`：主进程与界面共享的类型和协议。
- `resources/dsh`：DSH PC Manager 专用系统提示词补丁。
- `tests`：解析器测试与真实 DSH 隔离集成测试。
- `scripts`：构建补丁、图标渲染和可重复的 Electron 冒烟测试入口。
- `_local`：仅本机保存的 Release 安装包和上游参考资料，已被 Git 忽略。

## GitHub 发布

建议仓库标签使用 `v1.0`，仓库 Topics 使用 `electron`、`react`、`typescript`、`vite`、`windows`、`desktop-app`、`ai`、`deepseek`、`deepseek-harness`、`computer-manager`、`disk-cleaner`、`virus-scanner`、`privacy` 和 `cybersecurity`。完整的仓库描述、发布附件清单和上传命令见 [`GITHUB_UPLOAD.md`](GITHUB_UPLOAD.md)。
