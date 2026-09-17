# GitHub 上传与发布清单

本项目已按“源码仓库”和“发布附件”分离整理。源码仓库只提交可复现构建所需的源码、配置、测试和资源；依赖、构建输出、冒烟测试缓存、截图和安装包均不进入 Git。

## 仓库信息

- 建议仓库名：`dsh-pc-manager`
- 建议 Description：`Windows AI PC manager powered by DeepSeek Harness — scoped read-only scanning, safe cleanup review, and privacy-first desktop controls.`
- 建议默认分支：`main`
- 建议首个发布标签：`v0.3.0`
- 建议 Release 标题：`DSH PC Manager v0.3.0`

### GitHub Topics

把下面这些词粘贴到 GitHub 仓库的 Topics 中：

`electron` `react` `typescript` `vite` `windows` `desktop-app` `ai` `deepseek` `deepseek-harness` `computer-manager` `disk-cleaner` `virus-scanner` `privacy` `cybersecurity`

这些 Topics 与 `package.json` 中的 `keywords` 保持一致，便于 GitHub 和代码搜索识别项目技术栈与用途。

## Release 附件

根目录 `release/` 是本机打包输出目录，已被 `.gitignore` 排除，不要使用 `git add -f release` 强行加入仓库。

本次整理保留的历史安装包已收纳到项目内的 `_local/release/`；`_local/` 整体被忽略，只用于本机保存 Release 和参考资料，不属于 GitHub 源码仓库。

建议为 `v0.3.0` Release 上传：

- 当前保留的安装包：`_local/release/DSH-PC-Manager-0.3.0-Setup.exe`
- 当前保留的增量更新文件：`_local/release/DSH-PC-Manager-0.3.0-Setup.exe.blockmap`（需要增量更新时再上传）

如果重新运行 `npm run package`，新的构建产物会出现在根目录 `release/`；该目录同样已被忽略。

`release/win-unpacked/` 是免安装调试目录，通常不作为源码或 Release 附件上传。上传前请在 GitHub Release 页面确认附件中没有 API Key、日志或本机数据。

## 上传命令

如果本地还没有初始化 Git，可在项目根目录执行：

```powershell
git init -b main
git add .
git commit -m "chore: prepare GitHub repository"
git tag -a v0.3.0 -m "Release v0.3.0"
```

添加自己的 GitHub 仓库地址后推送：

```powershell
git remote add origin https://github.com/<OWNER>/dsh-pc-manager.git
git push -u origin main
git push origin v0.3.0
```

如果仓库已经存在远程地址，请先用 `git remote -v` 检查，避免把代码推到错误的仓库。

## 发布前检查

```powershell
npm install
npm run typecheck
npm test
npm run build
git status --short
git check-ignore -v release node_modules dist dist-electron artifacts
```

不要把真实 API Key 写入源码、`.env`、Issue 或提交记录。应用会在本机使用 Electron `safeStorage` 保存凭据；公开仓库只保留配置字段和使用说明。
