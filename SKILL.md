---
name: deepseek-share-transcript
description: Fetch a public DeepSeek share link and produce a verified UTF-8 Markdown transcript. Handles the fragments-based API (content field is deprecated), keeps TOOL_SEARCH / TOOL_OPEN citation chains as evidence, can include the model's THINK chain to reconstruct image-based questions without downloading images, and diagnoses attachment download failures.
version: 2.1.0
license: MIT
---

# DeepSeek 分享对话转录

当用户提供 `https://chat.deepseek.com/share/<share_id>` 链接，要求转录、导出、复盘或整理其中内容时使用本技能。

## 先决定交付什么

| 用户要什么 | 做什么 |
| --- | --- |
| 转录 / 导出原文 | 跑 `fetch_share_transcript.js`，交付 MD |
| 整理成笔记 / 入库 | 先转录，再按**目标知识库**的规范提炼。不要把原始转录当笔记 |
| 只要图片里的题面 | 先看 THINK（见下），多数情况不需要下载图片 |

## 接口结构（2026-11-12 实测，务必先读）

`biz_data.messages[].content` **已废弃**。正文在 `messages[].fragments[]`：

| fragment.type | 含义 | 处理 |
| --- | --- | --- |
| `REQUEST` | 用户输入正文 | USER 消息正文 |
| `RESPONSE` | 模型答复正文 | ASSISTANT 消息正文 |
| `THINK` | 模型内部思考 | 默认不输出；**可用于还原图片内容** |
| `TIP` | 免责声明横幅 | 忽略 |
| `FILE` | 附件 | `files[].file_name` / `.signed_path` / `.file_size` |
| `TOOL_SEARCH` | 联网搜索 | `content`（如 `Found 42 web pages`）/ `queries[]` / `results[]`（url、title、snippet、site_name） |
| `TOOL_OPEN` | 打开页面读全文 | `result{url,title,snippet,site_name,published_at}` |

**只读 `message.content` 会让每条消息都变成空正文，而"消息数一致"这种校验仍然通过**——这是静默失败，旧版脚本就中过招。脚本已改为读 fragments，并加了正文字符数与覆盖率两道兜底。

### TOOL_SEARCH / TOOL_OPEN 是证据链，不是正文（2026-11-12 新增）

DeepSeek 联网回答时会把检索过程单独放在这两种 fragment 里。它们不参与正文拼接，但归档时必须保留——否则转录出来的回答看起来像凭空断言。脚本现在会：

- 在每条消息的正文之后输出「本轮检索（证据链，非正文）」：搜索 query 原样列出，打开的页面给 title 链接 + 站点；
- 在文末输出「引用来源汇总」，按 URL 去重，只统计真正打开过的页面，搜索候选不重复罗列；
- 搜索结果明细（可能几十条）只写进 `--json` 的结构化文件，不进 MD，避免正文被候选列表淹没。

一个实用推论：**检索片段出现在哪几条消息，决定了哪些回答有事实支撑。** 如果中间十几轮没有任何 `TOOL_SEARCH`，那些结论就是模型自己给的，引用前需要另行核实。

## 用法

```bash
# 基本转录
node scripts/fetch_share_transcript.js "<share-url>" "out.md"

# 追加思考链（要还原图片内容时用）
node scripts/fetch_share_transcript.js "<share-url>" "out.md" --thinking

# 同时导出结构化 JSON（含检索结果明细、思考链、附件元数据）
node scripts/fetch_share_transcript.js "<share-url>" "out.md" --json "out.json"

# 下载图片附件（实测 signed_path 常已失效，见下方「附件下载」）
node scripts/download_attachments.js "out.json" "./images" --referer "<share-url>"
```

参数：`--force` 覆盖已存在文件；`--thinking` 把 THINK 一并写入 MD（会在文首标注这是推理草稿）。

需要 Node 18+（脚本依赖全局 `fetch`），零第三方依赖。

脚本成功后输出 JSON 统计：`messageCount`、`bodyChars`、`emptyMessages`、`fragmentTypes`、`unknownFragmentTypes`、`attachments`、`downloadable`。**`unknownFragmentTypes` 非空说明接口又变了，需要更新解析规则**；`emptyMessages` 是纯图片消息数（正常）。`TOOL_SEARCH`、`TOOL_OPEN` 已归入已知类型，不再触发告警。

## 还原图片内容的正确顺序

DeepSeek 读图后会在 THINK 里把题面、选项、用户代码**逐字复述**出来。所以：

1. **先读 THINK**（`--thinking` 或读 JSON 的 `thinking` 字段）。2026-10-04 实测：100 条消息里 17 张截图，全部题面都能从 THINK 还原，**一张都没下载**。
2. THINK 信息不全时才考虑下载图片。

依据 THINK 还原的内容必须标注来源是"思考链还原"，不能当作接口原文直述。

## 附件下载：signed_path 大概率失效（2026-10-04、2026-11-12 两次实测）

`FILE` fragment 的 `signed_path` 形如 `https://chat.deepseek.com/file?file_id=...&state=...`，看着完整可用，**但对分享页的附件实测返回 HTML 错误页而不是文件**（`content-type: text/html`）。

两次实测都复现了：图片如此，`26硬件机试题目.docx` 这样 20KB 的文档也如此，拿回来的是 8KB 左右的 DeepSeek 前端页面。

`download_attachments.js` 已经做了防护：

- 检查 `content-type` 是否为 `image/*`；
- 校验文件魔数（PNG/JPG/GIF/WEBP/BMP 签名，WEBP 额外查 `WEBP` 标记）；
- 失败时删除半成品、记 `status: failed`、全部失败时退出码 `2`。

**所以附件通常拿不到，这是数据本身的问题，不是脚本的问题。** 遇到 `failed` 时不要反复重试，直接回到 THINK：`VISION` 类附件的内容基本都在模型的思考链里被复述过。

## 边界

- 只读取公开分享内容，不登录、不 fork、不创建分享、不修改远端数据。
- 不把 THINK 当作对话正文输出，除非用户明确要；它是推理草稿，不等于最终答复。
- 图片附件默认只记文件名，不擅自 OCR。用户明确要求转录图片内容时另走图像查看/OCR 流程，并标为图片转录。
- 接口返回 `biz_code != 0` 或无 `messages` 时停止并报告具体错误，不凭页面摘要补写内容。

## 踩坑速查

脚本是纯 Node、零第三方依赖，装了 Node 18+ 就能跑。以下是**在 Windows + Git Bash 下实测**到的坑，换环境不一定复现，但遇到了能省时间。

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 传参路径风格 | Git Bash 里把参数写成 `/c/Users/...`，Windows 版 node 当相对路径，报 `Cannot find module 'd:\c\...'` | 传参一律用 `C:/…` / `D:/…` 风格 |
| 反引号被 shell 吞 | `node -e` 里写含模板字符串的 JS，正则退化成匹配单个字符 | 含反引号的 JS 写成 `.js` 文件再跑，别用 `-e` 内联 |
| PowerShell 抓不到 stdout | 只回退出码，输出全空 | 读输出用 Bash；PowerShell 里要 `\| Out-File` 再读文件 |
| 顶层 await 混用 | CommonJS 里同时用顶层 `await` 和 `require`，报 `ERR_AMBIGUOUS_MODULE_SYNTAX` | 用 `async function main()` 包起来 |
| Bash 里 `rm` 被拦 | 报 SIGTERM，命令被砍，看起来成功其实只删了一部分 | 删文件用 Node 的 `fs.unlinkSync` / `fs.rmSync` |

另外两点与路径无关：

- **转出的 MD 里会出现原对话的 `##` 标题**，套了代码围栏仍可能被某些阅读器当标题解析。归档回知识库前核对层级。
- **托管 Node 的补丁号会随升级变**。路径写死后失效，先 `ls <node-root>/versions/` 看当前目录名。

## 多副本安装

同一个技能可能同时装进多个 agent 的技能目录（WorkBuddy、Hana、Codex 各有一份）。它们是**独立的文件副本，不是软链**，改了一份不会影响其他份。

2026-11-12 就踩到过：主维护版已经升级到读 fragments，另一份还停在 2026-09 读 `thinking_content` 的版本，那份在新接口下必然产出全空正文，而且不会报错。

改完主版之后，把所有副本一起覆盖，然后逐个用真实分享链接跑一次冒烟，别只信文件时间戳。

## 实测记录

- 2026-09-14 冒烟：语法过；空参→用法错误；非 `chat.deepseek.com`→拒绝；非法 id→拒绝；假 id→`share does not exist`。
- 2026-10-04 两个真实链接（100 条消息 / 69589 正文字符 / 17 附件，以及 8 条 / 7436 字符 / 1 附件）：新脚本含覆盖率兜底后均 `validation: passed`，17 条纯图片消息被正确标为 `emptyMessages`，`unknownFragmentTypes` 为空。
- 2026-11-12 真实链接 `l82knwpi79qa8dxhpr`（34 条 / 23917 正文字符 / 17 REQUEST / 23 THINK / 3 TOOL_SEARCH / 19 TOOL_OPEN / 1 个 docx）：首次出现 `TOOL_SEARCH`、`TOOL_OPEN`，已补解析并输出 17 个去重引用页面。docx 的 `signed_path` 同样失效（返回 `text/html` 的 8622 字节页面）。

## License

MIT
