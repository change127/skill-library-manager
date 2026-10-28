# Skill 管理器

本地 Skill 目录管理工具。它扫描个人、系统、插件缓存和指定项目中的 `SKILL.md`，保留原始英文调用信息，同时管理中文展示名、说明、分类、收藏和最近引用。删除的 Skill 会保留为历史记录；界面默认显示“可用 Skill”。

## 运行

需要 Node.js。将此目录放在 `~/.codex/skills/skill-library-manager`，然后运行：

```sh
npm ci
npm start
```

也可运行 `node scripts/server.mjs` 启动仅监听 `127.0.0.1` 的网页界面。`npm test` 运行测试，`npm run dist` 在 Windows 上打包便携版。

## 数据与隐私

`data/catalog.json` 记录本机 Skill 路径与原始说明，`data/usage.json` 记录收藏和引用历史；备份、日志、依赖和可执行文件也只用于本地运行，已列入 `.gitignore`。公开仓库前请检查 Git 暂存区，尤其不要提交这些本地文件。`data/categories.json` 与 `data/settings.json` 是默认配置，修改后如需公开，请先检查内容。

服务端仅绑定回环地址。网页写接口要求本次启动生成的会话令牌；令牌只用于本地会话，不存盘。

## 许可证

本项目使用 [MIT 许可证](LICENSE)。
