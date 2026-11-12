# deepseek-share-transcript

把 DeepSeek 分享链接里的对话，导出成一份**经过校验**的 Markdown 转录。

针对 AI 编程助手的技能包（Skill），也可当普通 Node 脚本直接用。零第三方依赖，Node 18+ 即可。

```bash
node scripts/fetch_share_transcript.js "https://chat.deepseek.com/share/<id>" "out.md"
```

## 为什么需要这个

DeepSeek 的分享接口在 2026 年做过一次结构变更，正文字段从 `messages[].content` 挪到了 `messages[].fragments[]`，旧的 `content` 字段**保留但不再填充**。

这件事的杀伤力在于它**不报错**：脚本读 `content` 会拿到空字符串，于是每条消息都变成「[空白回复]」，而「消息数与接口一致」这种校验照样通过。你会拿到一份看起来结构完整、实则全是空壳的转录。

本脚本的处理：

- 按 `role` 从 `fragments` 取 `REQUEST` / `RESPONSE`，同时兼容旧结构；
- **三道兜底**：正文字符数必须 > 0、对话消息正文覆盖率不能低于 60%、逐条回读校验每段正文确实写进了文件；
- 任何一道不过就报错退出，不产出空壳文件。

## 另一个发现：图片题面不用下载

DeepSeek 读图后，会在内部思考链（`THINK` fragment）里把题面、选项、用户代码**逐字复述**出来。

实测中，一个 100 条消息、17 张截图的会话，**全部题面都能从 THINK 里还原出来，一张图都没下载**。

```bash
node scripts/fetch_share_transcript.js "<share-url>" "out.md" --thinking
```

这条经验直接省掉了图片 OCR 环节。需要说明的是：依据 THINK 还原的内容应当标注来源是「思考链还原」，不等于接口原文直述。

顺带一提，附件的 `signed_path` 看着像个完整可用的 URL，但对分享页的附件实测会返回 **HTML 错误页而不是文件**。所以 `download_attachments.js` 做了 `content-type` + 文件魔数双重校验——只看 HTTP 200 会把错误页当成 PNG 存下来。2026-11-12 又验了一次，这次的附件是一个 20KB 的 `.docx`，拿回来同样是 8KB 左右的 DeepSeek 前端页面。图片和文档一视同仁，都别抱希望。

## 第三个发现：联网检索是单独的片段

DeepSeek 在联网回答时，检索过程不会写进正文，而是另放两种 fragment：`TOOL_SEARCH`（查询词 + 候选结果列表）和 `TOOL_OPEN`（实际打开读过的页面）。

对转录来说这是个陷阱：正文拼装只看 `REQUEST` / `RESPONSE`，这两种类型会被静默跳过，于是导出的回答看起来像凭空断言，而你并不知道它引了 17 个页面。

v2.1.0 起脚本会把它们当证据链输出：

- 每条消息正文之后附「本轮检索」，列出搜索 query 和打开的页面；
- 文末附「引用来源汇总」，按 URL 去重，只统计真正打开过的；
- 搜索结果明细只进 JSON，不塞进 MD。

这个副产品挺有用：**检索片段出现在哪几条消息，就知道哪些回答有事实支撑。** 2026-11-12 实测的那个 34 条对话里，3 次搜索全挤在前两条回答，中间十几轮关于具体产品的讨论没有任何检索记录，那部分内容引用前得自己核。

## 安装

作为 Skill 使用时，把整个目录放进技能目录：

```
~/.workbuddy/skills/deepseek-share-transcript/
├── SKILL.md
├── scripts/
│   ├── fetch_share_transcript.js
│   └── download_attachments.js
└── agents/
    └── openai.yaml
```

直接当脚本用则只需 `scripts/` 下的两个文件。

## 用法

```bash
# 基本转录
node scripts/fetch_share_transcript.js "<share-url>" "out.md"

# 追加思考链（还原图片内容时用）
node scripts/fetch_share_transcript.js "<share-url>" "out.md" --thinking

# 同时导出结构化 JSON，供下载附件脚本消费
node scripts/fetch_share_transcript.js "<share-url>" "out.md" --json "out.json"

# 下载图片附件（注意 signed_path 常已失效）
node scripts/download_attachments.js "out.json" "./images" --referer "<share-url>"
```

参数：`--force` 覆盖已存在文件。输出为 UTF-8 Markdown。

成功时打印 JSON 统计：

| 字段 | 含义 |
| --- | --- |
| `messageCount` | 接口返回的消息数 |
| `bodyChars` | 正文总字符数，**为 0 说明接口结构变了** |
| `emptyMessages` | 正文为空的消息数（纯图片消息，正常） |
| `fragmentTypes` | 各类型 fragment 出现次数 |
| `unknownFragmentTypes` | **非空说明接口又变了，需要更新解析规则** |
| `attachments` / `downloadable` | 附件总数 / 带下载链接的数 |

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 参数错误、接口不可用、校验失败 |
| 2 | `download_attachments.js`：附件全部下载失败 |

## 边界

- 只读取**公开**分享内容，不登录、不 fork、不创建分享、不修改远端数据。
- 不把 THINK 当作对话正文输出，除非明确要求——它是推理草稿，不等于最终答复。
- 图片默认只记文件名，不擅自 OCR。
- 接口返回 `biz_code != 0` 或无 `messages` 时停止并报具体错误，不凭页面摘要补写内容。

## Windows / Git Bash 踩坑速查

以下是实测踩到的，换环境不一定复现：

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| 传参路径风格 | Git Bash 里写 `/c/Users/...`，Windows 版 node 当相对路径，报 `Cannot find module 'd:\c\...'` | 传参用 `C:/…` / `D:/…` |
| 反引号被 shell 吞 | `node -e` 里含模板字符串，正则退化成匹配单个字符 | 写成 `.js` 文件再跑 |
| PowerShell 抓不到 stdout | 只回退出码 | 读输出用 Bash；PowerShell 里 `\| Out-File` 再读 |
| 顶层 await 混用 | CommonJS 同时用顶层 `await` 和 `require` → `ERR_AMBIGUOUS_MODULE_SYNTAX` | `async function main()` 包起来 |

另外：转出的 MD 里会出现原对话的 `##` 标题，套了代码围栏仍可能被某些阅读器当标题解析，归档回知识库前核对层级。

## 维护

接口是 DeepSeek 私有 API，没有稳定性承诺。升级后先跑一次：

- `unknownFragmentTypes` 非空 → 在 `diagnose()` 的 `known` 集合里补上新类型，再决定要不要解析它；
- `bodyChars` 为 0 → fragment 的取值逻辑变了，检查 `extractContent()`。

已经踩过两次这个流程：2026 年那次是 `content` 字段废弃、正文搬到 `fragments[]`；2026-11-12 这次是新增 `TOOL_SEARCH` / `TOOL_OPEN`。两次都是**不报错的结构变更**，只能靠 `unknownFragmentTypes` 和 `bodyChars` 这两个哨兵发现。

另外，同一个 skill 可能同时装在多个 agent 的技能目录下，那些是独立副本不是软链。改完主版记得把副本全覆盖一遍，并各跑一次真实链接冒烟，别只看文件时间戳。

`SKILL.md` 里「实测记录」一节按日期追加，方便回溯。

## License

[MIT](LICENSE)