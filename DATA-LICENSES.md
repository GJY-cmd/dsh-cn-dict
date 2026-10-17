# 数据来源、许可与构建期网络访问

本项目的**代码**是 MIT。但代码构建出的**词库**由多份第三方数据拼合而成，受各自许可约束。

**请先读结论：[最需要注意的一点](#最需要注意的一点)。**

## 数据源一览

| # | 数据源 | 仓库 / 出处 | 许可 | 进入哪些表 |
|---|---|---|---|---|
| 1 | `chinese-xinhua` | https://github.com/pwxcoo/chinese-xinhua | **MIT**（有 LICENSE 文件，Copyright (c) 2018 PWXCOO） | `words`、`ci`、`idioms`、`xiehouyu` |
| 2 | `chinese_dictionary` | https://github.com/max32002/chinese_dictionary | ⚠️ **无 LICENSE 文件** | `chars` |
| 3 | CC-CEDICT | 官方导出：https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz<br>项目主页：https://cc-cedict.org/wiki/start | **CC BY-SA 4.0** | `english` |
| 4 | 繁简映射 | 由 1、3 推导（`word.json` 的 `oldword`、CC-CEDICT 的繁简对） | 随来源 | `simp_of` |
| 5 | 全文索引 | 由上述内容推导（SQLite FTS5） | 随来源 | `search_fts` |

具体字段与条数见主 [README](./README.md#形成的表结构)。

## 最需要注意的一点

**第 2 项 `max32002/chinese_dictionary` 没有 LICENSE 文件。**

它的 README 自述：

> 一個簡易的字典。能查文字「部首」、「筆畫」的文字數有 81,052 筆, **資料主是從別人的資料庫搬出來的**, 很多年沒去更新, 也許有些資料是錯誤的。

README 末尾只列了一组"相關網頁"（漢字構形資料庫 `cdp.sinica.edu.tw`、部件檢索 `fgwang.blogspot.com`、漢字データベースプロジェクト `kanji-database.sourceforge.net` 等），**没有给出授权声明，也没有说明究竟搬自哪一份**。

这意味着：

- 无法履行任何"署名"义务——因为不知道该署谁的名
- 该数据的再分发权限**不明确**
- 其中 `chars` 表的 81,052 条是本项目字级能力（部首/笔画/异体字/组件/粤语闽南音）的**唯一来源**

**因此：本仓库不分发任何数据**，只提供建库脚本，由使用者自行获取。若你希望完全避开这一项，请按主 README 的[只用许可清晰的来源](./README.md#只用许可清晰的来源推荐做法)一节操作——代价是失去字级资料。

## 许可组合的实际效果

若把三份数据合并进同一个 SQLite（默认行为），整体成为**衍生作品**，须同时满足各来源要求，其中约束最强的决定了整体：

| 来源 | 要求 | 对合并库的影响 |
|---|---|---|
| MIT（第 1 项） | 保留版权与许可声明 | 需在 NOTICE 中保留 PWXCOO 的 MIT 声明 |
| CC BY-SA 4.0（第 3 项） | 署名 + **相同方式共享**（传染性） | **整个组合库须以 CC BY-SA 4.0 发布** |
| 无许可（第 2 项） | 无 | **无法合规**——这是唯一真正的灰区 |

即：**合并库不能以 MIT 发布**。代码是 MIT，数据不是——两者必须分开陈述。

## 构建期的网络访问

建库脚本**自带下载**：首次运行时把下列文件取到缓存目录（脚本内 `SOURCES` 数组）。

| 文件 | 实际请求的地址 | 字节数（用于校验） |
|---|---|---|
| `word.json` | GitHub raw：`pwxcoo/chinese-xinhua/master/data/word.json` | 27,354,320 |
| `ci.json` | 同上 → `/ci.json` | 26,129,191 |
| `idiom.json` | 同上 → `/idiom.json` | 10,319,857 |
| `xiehouyu.json` | 同上 → `/xiehouyu.json` | 约 1.2 MB |
| `Dictionary.json` | GitHub raw：`max32002/chinese_dictionary/master/Dictionary.json` | 33,190,508 |
| `cedict.txt.gz` | `https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz` | 3,981,100 |

### 关于 GitHub 代理（重要）

部分网络环境下 `raw.githubusercontent.com` 直连受限，因此脚本内置两个**公共第三方 GitHub 代理前缀**并在其间轮换重试：`ghproxy.net`、`gh-proxy.com`。

- 请求会**经过这些第三方服务**——你的请求内容、来源 IP 等对它们可见
- 它们与本项目**无任何关联**，可用性、稳定性与隐私处理**不作任何保证**
- 有能力直连的环境**建议清空代理数组改用直连**（脚本顶部常量）
- 不信任代理的用户可以**完全不用脚本下载**：自行把 6 个文件放进缓存目录，脚本按字节数校验后会直接使用
- 本项目不对任何代理服务背书，选择使用即自担风险

### 关于 mdbg.net

CC-CEDICT 的官方导出由 mdbg.net 提供，是 CC BY-SA 4.0 数据的正规分发渠道之一；但它是**动态导出端点而非稳定文件 URL**，偶发不可用。若取不到，请从 [CC-CEDICT 项目主页](https://cc-cedict.org/wiki/start) 找其他分发渠道，并自行压缩为 gzip、命名为 `cedict.txt.gz` 放入缓存目录。

## 署名与再分发要求（若你对外分发词库）

1. **保留 MIT 声明**：`chinese-xinhua` 的版权与 MIT 许可全文（见 [NOTICE](./NOTICE)）
2. **CC BY-SA 4.0 署名**：标明 CC-CEDICT 来源（https://cc-cedict.org/）与许可，并**以相同许可发布你的衍生库**
3. **说明第 2 项的状态**：诚实标注"上游未声明许可、来源不明"，让下游使用者自行判断
4. **不要声称词库是 MIT**，也不要声称数据属于本项目

## 关于本项目对数据的处理

建库脚本只做**本地读取与转换**，不发起网络请求。转换包括（都会形成衍生作品）：

- CSV/JSON 字段解析，转写进 SQLite 表结构
- 释义文本按 `\n` 字面量还原为换行
- 从 `exchange` / `oldword` / CC-CEDICT 繁简对推导出繁简映射表 `simp_of`
- 建立 FTS5 全文索引 `search_fts`
- 不修改释义措辞（仅查询时按档位截断输出）

## 免责声明

本项目仅提供建库**脚本**，不附带、也不代为分发任何词库数据。上游数据的著作权、许可与合法性请使用者自行核实。作者不对上游数据的许可状态、准确性或合法性作任何保证，也不对使用者依此获取或分发数据所产生的后果承担责任。本文档不构成法律意见。
