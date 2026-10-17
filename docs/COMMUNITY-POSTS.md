# 社区发布文案（@GJY-cmd/dsh-cn-dict）

> 下面的文案已按各渠道的惯例写好，复制即可。**仓库地址需在创建 repo 后补全。**

---

## 1. GitHub 仓库描述（About 一栏，建议 ≤120 字符）

```text
给 DeepSeek Harness 用的本地离线汉语词典模式：字/词/成语/歇后语/汉英对译，零依赖插件 + 自带建库脚本
```

## 2. GitHub Topics（照抄，用空格分隔）

```text
dsh-plugin deepseek-harness dsh dictionary chinese-dictionary offline dictionary-plugin
```

## 3. GitHub Release 说明 / 首次提交说明

```markdown
## 首个版本：本地离线汉语词典模式

- 一个 Agent 模式（「汉语词典」）+ 模型工具 `dict_lookup`
- 覆盖字级（部首/笔画/异体字/文字组件/粤语闽南音）、词语释义、成语、歇后语、汉英对译
- 繁体输入自动折简；未收录时给出相近词条
- 零第三方依赖，只用 Node 内置 `node:sqlite`
- 自带建库脚本，一条命令生成约 182 MB 词库

**不附带词库数据**，由建库脚本按需下载；数据许可与署名要求见 README 与 NOTICE。
```

## 4. npm 包说明（发布时 description 已写在 package.json）

发布命令：

```bash
cd release/dsh-cn-dict && npm publish --access public
```

## 5. 社区论坛 / 讨论区发帖（中文）

```markdown
## [插件] 汉语词典 —— 给 DSH 加一个本地离线的词典模式

做了一个 DSH 插件：新增「汉语词典」Agent 模式，会话里可以查字、词、成语、歇后语和汉英对译。

**特点**
- 完全本地：词库是 SQLite，查询不联网、不依赖任何 API
- 零依赖：插件只用 Node 内置 `node:sqlite`，不用装任何东西
- 繁体自动折简；未收录会告诉你，模型不会瞎编
- 自带建库脚本，首次运行下载约 98 MB 数据，生成约 182 MB 词库

**数据来源**（重要，请自行判断）
- 词语/成语/歇后语：chinese-xinhua（MIT）
- 汉英对译：CC-CEDICT（CC BY-SA 4.0，有传染性）
- 字级资料：一份上游**未声明许可**的数据，README 里有说明；不放心可以只用前两份

仓库不附带词库数据，只放代码和建库脚本。

**安装**：推荐直接让你的 AI 编码助手装，README 里有可复制的一段话；也支持手工安装。

仓库：<待填>
```

## 6. 提交到 awesome-dsh-plugin / 插件市场

这两个市场都是**自动抓取**的，通常不需要手动提交：

- 插件市场聚合 `awesome-dsh-plugin.com/updates.json`，并抓 GitHub 的 `topic:dsh-plugin` 与 npm 包
- 所以只要：**仓库打上 `dsh-plugin` topic**、**package.json 里 `dsh` 字段完整**、**可选地发到 npm**，一般会被自动收录
- 若迟迟未收录，可到 `awesome-dsh-plugin` 仓库提 issue（用上面的仓库描述）

## 7. 发帖前自检

- [ ] 仓库 About 描述已填、Topics 已加 `dsh-plugin`
- [ ] `npm publish --dry-run` 通过，`files` 字段只打含代码与文档
- [ ] 仓库里**没有** `chinese.sqlite` / `cache/`（`.gitignore` 已挡）
- [ ] README 里的占位符已全部替换（`@${SCOPE}` / `${OWNER}`）
