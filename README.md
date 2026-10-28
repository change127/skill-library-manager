# Skill 管理器（Skill Library Manager）

Skill 越装越多，想找一个能用的，却想不起它叫什么？**Skill 管理器**把本机的 Codex Skills 整理成一个可以搜索、筛选和收藏的中文技能库。它既是一份可在 Codex 中调用的 Skill，也带有一个本地桌面界面。

> 中文名称和说明用于浏览；在聊天中调用时，仍使用原来的 `$英文名称`。

## 它能做什么

- **找到本机的 Skill**：扫描个人 Skill 目录、用户 Skill 目录、Codex 插件缓存，也可以通过命令指定项目目录。
- **用中文整理**：维护中文展示名、简短说明和分类，同时保留 `SKILL.md` 中的原始名称与说明。
- **快速找到要用的 Skill**：搜索名称和用途，按来源、本地化状态或分类筛选；收藏常用 Skill，查看最近复制过的调用名。
- **分清可用与历史记录**：默认只看当前可用的 Skill。删除或移走的 Skill 会标为“已失效”，仍可在“全部记录”中找到历史信息。
- **处理待办**：集中查看待汉化、需要修复和已失效的条目。修改元数据前会备份，并根据来源执行确认规则。

## 界面是什么样的

打开后，界面分成三块：左侧是搜索和导航，中间是 Skill 列表，选中条目后右侧显示详情。顶部的 **“扫描更新”** 可以重新检查本机目录。

| 位置 | 可以做什么 |
| --- | --- |
| 左侧搜索与筛选 | 按名称、用途、调用名搜索；按来源、本地化状态和分类缩小范围。 |
| “可用 Skill” | 默认入口，只显示当前能找到的 Skill。 |
| “全部记录” | 查看完整清单，包括已经删除或移走的 Skill。 |
| “我的收藏”“最近引用” | 快速回到常用或最近复制过调用名的 Skill。 |
| “待处理中心” | 查看待汉化、需要修复和已失效的条目。 |
| 中间列表 | 看到中文名称、`$英文调用名`、用途简介和可用状态；点击 ☆ 可以收藏。 |
| 右侧详情 | 编辑中文展示名、中文说明和分类；核对原始英文信息；复制调用名或恢复最近一次备份的元数据。 |

例如，你想找一个处理 PDF 的 Skill：在搜索框输入 `PDF`，点开结果查看用途，再点 **“复制调用名”**，把复制的 `$名称` 粘贴到 Codex 聊天框即可。复制操作也会把它加入“最近引用”。

**关于“已失效”**：它表示扫描时找不到原来的 Skill 文件，不等于管理器替你删除了文件。“全部记录”保留这条信息，方便你回顾；“恢复”按钮用于恢复元数据备份，不能重新安装已删除的 Skill。

## 安装与启动

需要 [Node.js](https://nodejs.org/) 和 Git。把仓库放到 Codex 的个人 Skill 目录，安装依赖后启动。

**Windows PowerShell：**

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.codex\skills" | Out-Null
git clone https://github.com/change127/skill-library-manager.git "$HOME\.codex\skills\skill-library-manager"
Set-Location "$HOME\.codex\skills\skill-library-manager"
npm ci
npm start
```

**macOS / Linux 终端：**

```sh
git clone https://github.com/change127/skill-library-manager.git ~/.codex/skills/skill-library-manager
cd ~/.codex/skills/skill-library-manager
npm ci
npm start
```

`npm start` 打开桌面窗口。Windows 用户安装依赖后，也可以双击目录中的 `Skill-Manager.cmd` 启动。首次打开会扫描本机 Skill；以后新装或移走 Skill，可以点右上角的 **“扫描更新”**。

如果你更喜欢在浏览器中使用，可在这个目录运行：

```sh
node scripts/server.mjs
```

终端会显示形如 `http://127.0.0.1:端口号` 的地址，用浏览器打开即可。服务只监听本机回环地址。

> 已有同名目录时，请先确认其中是否有自己的数据和修改，再决定如何更新；不要直接用新克隆覆盖。

## 在 Codex 中怎么用

安装到上述 Skill 目录后，可以在聊天中直接说明需求，例如：

```text
用 $skill-library-manager 打开我的 Skill 管理器。
用 $skill-library-manager 扫描一下新安装的 Skill，并列出待处理项。
用 $skill-library-manager 帮我整理这些 Skill 的中文名称和分类。
```

管理器可以辅助扫描、整理、校验和打开界面。**安装新的 Skill** 时，它会调用 Codex 的 `$skill-installer` 完成安装，再把新 Skill 纳入清单。若某个 Skill 是在管理器之外安装的，下次打开界面或执行扫描时也能发现它。

中文展示名不会替换调用名。比如界面显示“PDF 阅读助手 · `$pdf-reader`”，聊天中应使用 `$pdf-reader`。

## 常见操作

1. **找 Skill**：打开界面，在“可用 Skill”中搜索关键词；如果找不到，点“扫描更新”，再检查来源和状态筛选。
2. **整理 Skill**：点选列表条目，在右侧填写中文展示名、中文说明，选择分类，然后保存。受保护来源会要求勾选确认。
3. **使用 Skill**：点“复制调用名”，回到 Codex 聊天框粘贴；也可以直接输入右侧显示的 `$英文调用名`。
4. **回顾已删除的 Skill**：切到“全部记录”或“待处理中心 → 已失效”。重新安装后再扫描，管理器会检查是否能重新匹配。
5. **撤销元数据修改**：选中仍可用的 Skill，点“恢复”以恢复最近一次备份的元数据。

## 命令行用法

在仓库目录运行以下命令；需要机器可读结果时加 `--json`：

```sh
node scripts/manager.mjs scan
node scripts/manager.mjs validate
node scripts/manager.mjs categories list
```

`scan` 更新清单，`validate` 检查清单和元数据，`categories list` 查看可选分类。若要扫描某个项目中的 Skill，可运行 `node scripts/manager.mjs scan --project-root 路径`。安装前后对比可依次运行 `snapshot`、安装 Skill、`scan`、`changes`。完整命令及参数见 [SKILL.md](SKILL.md#command-reference)。

开发者可以运行 `npm test` 执行测试；在 Windows 上运行 `npm run dist` 可生成便携版程序。便携版会读取安装在 `~/.codex/skills/skill-library-manager` 的管理器数据和脚本。

## 数据与隐私

管理器在本机运行。它扫描 `SKILL.md` 并把清单保存在本地；收藏、最近引用和备份也保存在本地。网页写入操作使用本次启动生成的会话令牌，令牌不写入磁盘。

`data/catalog.json`、`data/usage.json`、备份、日志、依赖和可执行文件已列入 `.gitignore`，不会作为本仓库的默认内容发布。如果你准备提交自己的修改，请先检查暂存区，避免把个人 Skill 路径或使用记录提交到公开仓库。`data/categories.json` 和 `data/settings.json` 是随仓库提供的默认配置；修改后公开前也请检查内容。

## 许可证

本项目使用 [MIT 许可证](LICENSE)。
