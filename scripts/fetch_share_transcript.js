const fs = require('fs');
const path = require('path');

// ============================================================================
// DeepSeek 分享对话抓取
//
// 接口结构（2026-10-04 实测确认，2026-09 旧版已废弃）：
//   biz_data.messages[].content  →  已废弃，不要读
//   biz_data.messages[].fragments[]  →  正文在这里
//     type=REQUEST  → USER 消息的输入正文
//     type=RESPONSE → ASSISTANT 消息的答复正文
//     type=THINK    → 模型内部思考，不作为正文输出
//     type=TIP      → 免责声明横幅，忽略
//     type=FILE     → 附件，files[].file_name / .signed_path / .file_size
//
// 只读 message.content 会让每条消息都变成空正文，而朴素的"消息数一致"校验
// 仍然通过——这是静默失败。本脚本用正文覆盖率兜底。
// ============================================================================

function fail(message) {
  throw new Error(message);
}

function parseShareId(input) {
  const value = String(input || '').trim();
  if (!value) fail('请提供 DeepSeek 分享链接或 share_id');

  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(`无法解析链接：${value}`);
    }
    if (url.hostname !== 'chat.deepseek.com') {
      fail(`链接域名不是 chat.deepseek.com：${url.hostname}`);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'share' || !parts[1]) {
      fail('链接路径应为 /share/<share_id>');
    }
    return decodeURIComponent(parts[1]);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('share_id 只允许字母、数字、下划线和连字符');
  }
  return value;
}

function fenceFor(text) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(4, longest + 1));
}

function shanghaiTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function roleName(role) {
  if (role === 'USER') return '用户';
  if (role === 'ASSISTANT') return 'DeepSeek';
  return role || '未知角色';
}

function isUsableFile(file) {
  // from_share=false 的附件 signed_path 可能已失效，仍然记文件名
  return file && (file.file_name || file.id);
}

// ---------------------------------------------------------------------------
// 正文与附件抽取：优先 fragments，兼容旧版 content
// ---------------------------------------------------------------------------

function extractContent(message) {
  // 旧结构兜底。若 fragments 缺失而 content 有值，说明接口回退到了旧版。
  if (typeof message.content === 'string' && message.content.length > 0) {
    return message.content;
  }

  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const wanted = message.role === 'USER' ? ['REQUEST'] : ['RESPONSE'];
  const parts = [];
  for (const fragment of fragments) {
    if (!wanted.includes(fragment.type)) continue;
    if (typeof fragment.content === 'string' && fragment.content.length > 0) {
      parts.push(fragment.content);
    }
  }
  return parts.join('\n\n');
}

function extractFiles(message) {
  if (Array.isArray(message.files) && message.files.length > 0) return message.files;

  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const files = [];
  for (const fragment of fragments) {
    if (fragment.type !== 'FILE' || !Array.isArray(fragment.files)) continue;
    for (const file of fragment.files) {
      if (isUsableFile(file)) files.push(file);
    }
  }
  return files;
}

function fileName(file) {
  return file.file_name || file.id || '[未命名附件]';
}

function absoluteFileUrl(file) {
  const signed = file.signed_path;
  if (!signed) return null;
  return signed.startsWith('http') ? signed : `https://chat.deepseek.com${signed}`;
}

function mdLink(label, url) {
  const text = String(label || url || '');
  if (/[[\]]/.test(text)) return `${text.replace(/[[\]]/g, '')} <${url}>`;
  return `[${text}](${url})`;
}

// 2026-11-12 新增：DeepSeek 开始返回联网检索片段。
//   TOOL_SEARCH: status / content（如 "Found 42 web pages"）/ queries[] / results[]
//   TOOL_OPEN:   status / result{url,title,snippet,site_name,published_at} / reference
// 正文不住在这里，但它们是引用的证据链，归档时必须留下来源。
function extractTools(message) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const searches = [];
  const opens = [];

  for (const fragment of fragments) {
    if (fragment.type === 'TOOL_SEARCH') {
      searches.push({
        status: fragment.status || null,
        summary: typeof fragment.content === 'string' ? fragment.content : null,
        queries: (Array.isArray(fragment.queries) ? fragment.queries : [])
          .map((q) => (typeof q === 'string' ? q : q && q.query))
          .filter(Boolean),
        results: (Array.isArray(fragment.results) ? fragment.results : []).map((r) => ({
          title: r.title || null,
          url: r.url || null,
          site: r.site_name || null,
          publishedAt: r.published_at ?? null,
        })),
      });
    } else if (fragment.type === 'TOOL_OPEN') {
      const r = fragment.result || {};
      opens.push({
        status: fragment.status || null,
        title: r.title || null,
        url: r.url || null,
        site: r.site_name || null,
        snippet: r.snippet || null,
        publishedAt: r.published_at ?? null,
      });
    }
  }

  return { searches, opens };
}

// ---------------------------------------------------------------------------
// 结构诊断：判断接口是否还能按预期解析
// ---------------------------------------------------------------------------

function diagnose(messages) {
  const fragTypes = {};
  let withFragments = 0;
  let withLegacyContent = 0;
  let fileCount = 0;
  let downloadable = 0;

  for (const m of messages) {
    if (Array.isArray(m.fragments) && m.fragments.length > 0) {
      withFragments++;
      for (const f of m.fragments) {
        fragTypes[f.type] = (fragTypes[f.type] || 0) + 1;
        if (f.type === 'FILE' && Array.isArray(f.files)) {
          fileCount += f.files.length;
          downloadable += f.files.filter((x) => x.signed_path).length;
        }
      }
    }
    if (typeof m.content === 'string' && m.content.length > 0) withLegacyContent++;
  }

  const known = new Set(['REQUEST', 'RESPONSE', 'THINK', 'TIP', 'FILE', 'TOOL_SEARCH', 'TOOL_OPEN']);
  const unknown = Object.keys(fragTypes).filter((k) => !known.has(k));

  return {
    messageCount: messages.length,
    withFragments,
    withLegacyContent,
    fragmentTypes: fragTypes,
    unknownFragmentTypes: unknown,
    fileCount,
    downloadable,
  };
}

// ---------------------------------------------------------------------------
// 转录构建
// ---------------------------------------------------------------------------

function buildTranscript(data, sourceUrl, options) {
  const messages = data.messages;
  const wantThinking = options.thinking;
  const diag = diagnose(messages);

  const lines = [
    '# DeepSeek 分享对话转录',
    '',
    `来源：${sourceUrl}`,
    `抓取时间（Asia/Shanghai）：${shanghaiTime()}`,
    `可见消息数：${messages.length}`,
    '',
    '说明：以下按分享接口返回的原始顺序转录。正文取自 fragments（REQUEST / RESPONSE），',
    '思考链（THINK）默认不展开；图片附件记录文件名与可直接下载的链接，不做 OCR。',
    '',
  ];

  if (wantThinking) {
    lines.push('> 本次包含模型内部思考链（THINK fragment）。它是模型的推理草稿，不等于最终答复，引用前请自行核对。', '');
  }
  if (diag.unknownFragmentTypes.length > 0) {
    lines.push(`> 注意：接口出现未知 fragment 类型 ${diag.unknownFragmentTypes.join(', ')}，可能需要更新本脚本的解析规则。`, '');
  }

  let bodyChars = 0;
  let emptyCount = 0;

  messages.forEach((message, index) => {
    const content = extractContent(message);
    const files = extractFiles(message);
    const hasBody = typeof content === 'string' && content.length > 0;
    if (hasBody) bodyChars += content.length;
    else emptyCount += 1;
    const safeContent = hasBody ? content : '[空白回复]';

    lines.push(`## 消息 ${index + 1} · ${roleName(message.role)}`);
    lines.push('');
    lines.push(`原始 message_id：${message.message_id}`);

    if (files.length > 0) {
      lines.push('');
      lines.push('附件：');
      for (const file of files) {
        const url = absoluteFileUrl(file);
        const size = file.file_size ? `（${file.file_size} 字节）` : '';
        lines.push(`- ${fileName(file)}${size}`);
        if (url) lines.push(`  下载：${url}`);
      }
    }

    lines.push('');
    const fence = fenceFor(safeContent);
    lines.push(fence);
    lines.push(safeContent);
    lines.push(fence);

    const tools = extractTools(message);
    if (tools.searches.length > 0 || tools.opens.length > 0) {
      lines.push('');
      lines.push('本轮检索（证据链，非正文）：');
      for (const search of tools.searches) {
        const queries = search.queries.length ? search.queries.join(' / ') : '(未记录 query)';
        const summary = search.summary ? `（${search.summary}）` : '';
        lines.push(`- 网页搜索${summary}：${queries}`);
      }
      for (const open of tools.opens) {
        const label = open.title || open.url || '(无标题)';
        const site = open.site ? ` · ${open.site}` : '';
        if (open.url) lines.push(`- 打开页面：${mdLink(label, open.url)}${site}`);
        else lines.push(`- 打开页面：${label}${site}`);
      }
    }

    if (wantThinking) {
      const fragments = Array.isArray(message.fragments) ? message.fragments : [];
      const thinking = fragments
        .filter((f) => f.type === 'THINK' && typeof f.content === 'string' && f.content.trim())
        .map((f) => f.content.trim())
        .join('\n\n');
      if (thinking) {
        const tfence = fenceFor(thinking);
        lines.push('');
        lines.push('内部思考链（THINK）：');
        lines.push(tfence);
        lines.push(thinking);
        lines.push(tfence);
      }
    }

    lines.push('');
  });

  // 引用来源汇总：只统计实际打开过的页面。搜索候选列表不在这里重复列出。
  const opened = new Map();
  for (const message of messages) {
    for (const open of extractTools(message).opens) {
      if (!open.url || opened.has(open.url)) continue;
      opened.set(open.url, open);
    }
  }
  if (opened.size > 0) {
    lines.push('## 引用来源汇总');
    lines.push('');
    lines.push(`共打开 ${opened.size} 个页面（按 URL 去重）。搜索候选但未打开的链接不在此列。`);
    lines.push('');
    for (const [url, open] of opened) {
      const site = open.site ? ` · ${open.site}` : '';
      lines.push(`- ${mdLink(open.title || url, url)}${site}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n'), bodyChars, emptyCount, diag };
}

// ---------------------------------------------------------------------------
// 校验：宁可失败也不产出空壳
// ---------------------------------------------------------------------------

function validate(text, messages, stats) {
  const markerCount = (text.match(/^## 消息 /gm) || []).length;
  if (markerCount !== messages.length) {
    fail(`转录校验失败：消息标题 ${markerCount} 条，接口返回 ${messages.length} 条`);
  }

  // 核心兜底：接口结构再变一次时，正文会全空而消息数仍然对得上。
  if (stats.bodyChars === 0) {
    fail('转录校验失败：所有消息正文均为空。接口结构很可能已变更（当前脚本读 fragments[REQUEST|RESPONSE]），需要更新解析规则后再试。');
  }

  // 覆盖率兜底：正常对话里 USER / ASSISTANT 交替，绝大多数消息应有正文。
  const expectBody = messages.filter((m) => m.role === 'USER' || m.role === 'ASSISTANT').length;
  const emptyBody = stats.emptyCount;
  if (expectBody > 0 && emptyBody / expectBody > 0.6) {
    fail(`转录校验失败：${expectBody} 条对话消息中有 ${emptyBody} 条正文为空（覆盖率 ${(100 * (expectBody - emptyBody) / expectBody).toFixed(0)}%）。这不像正常的纯图片对话，请确认接口结构未变更。`);
  }

  const missing = [];
  for (const [index, message] of messages.entries()) {
    const content = extractContent(message);
    if (content && !text.includes(content)) missing.push(`消息 ${index + 1} 正文`);
    for (const file of extractFiles(message)) {
      const name = fileName(file);
      if (!text.includes(name)) missing.push(`消息 ${index + 1} 附件 ${name}`);
    }
  }
  if (missing.length > 0) fail(`转录校验失败，缺少：${missing.join('；')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const withThinking = args.includes('--thinking');
  const jsonIndex = args.indexOf('--json');
  let jsonPath = null;
  if (jsonIndex >= 0) {
    jsonPath = args[jsonIndex + 1] || null;
    args.splice(jsonIndex, 2);
    if (!jsonPath) fail('--json 需要跟一个输出路径');
  }
  const filtered = args.filter((a) => a !== '--force' && a !== '--thinking');
  if (filtered.length < 1 || filtered.length > 2) {
    fail('用法：node fetch_share_transcript.js <share-url-or-id> [output-path] [--force] [--thinking] [--json <path>]');
  }

  const shareId = parseShareId(filtered[0]);
  const sourceUrl = `https://chat.deepseek.com/share/${shareId}`;
  const apiUrl = `https://chat.deepseek.com/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`;
  const outputPath = path.resolve(filtered[1] || `DeepSeek分享对话-${shareId}.md`);

  if (fs.existsSync(outputPath) && !force) {
    fail(`输出文件已存在：${outputPath}；如确认覆盖，请追加 --force`);
  }

  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/json',
      Referer: sourceUrl,
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const raw = await response.text();
  if (!response.ok) fail(`分享接口请求失败：HTTP ${response.status}`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail(`分享接口没有返回可解析的 JSON（前 200 字符：${raw.slice(0, 200)}）`);
  }

  const data = payload?.data?.biz_data;
  const bizCode = payload?.data?.biz_code;
  if (!data || !Array.isArray(data.messages)) {
    const detail = payload?.msg || payload?.data?.biz_msg || `biz_code=${bizCode}`;
    fail(`分享内容不可用：${detail}`);
  }

  const { text, bodyChars, emptyCount, diag } = buildTranscript(data, sourceUrl, { thinking: withThinking });
  validate(text, data.messages, { bodyChars, emptyCount });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, 'utf8');
  const readBack = fs.readFileSync(outputPath, 'utf8');
  validate(readBack, data.messages, { bodyChars, emptyCount });

  // 可选：导出结构化 JSON，供后续脚本（看思考链、下图片）使用
  if (jsonPath) {
    const dump = {
      share_id: shareId,
      source_url: sourceUrl,
      fetched_at: shanghaiTime(),
      messages: data.messages.map((m) => ({
        index: data.messages.indexOf(m) + 1,
        message_id: m.message_id,
        role: m.role,
        content: extractContent(m),
        thinking: (m.fragments || [])
          .filter((f) => f.type === 'THINK')
          .map((f) => f.content)
          .filter(Boolean)
          .join('\n\n'),
        tools: extractTools(m),
        files: extractFiles(m).map((f) => ({
          file_name: f.file_name || null,
          file_id: f.id || null,
          file_size: f.file_size ?? null,
          model_kind: f.model_kind || null,
          is_image: f.is_image ?? null,
          url: absoluteFileUrl(f),
        })),
      })),
    };
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2), 'utf8');
  }

  console.log(JSON.stringify({
    outputPath,
    jsonPath,
    messageCount: data.messages.length,
    bodyChars,
    emptyMessages: emptyCount,
    byteLength: fs.statSync(outputPath).size,
    fragmentTypes: diag.fragmentTypes,
    unknownFragmentTypes: diag.unknownFragmentTypes,
    attachments: diag.fileCount,
    downloadable: diag.downloadable,
    legacyContentMessages: diag.withLegacyContent,
    firstMessageId: data.messages[0]?.message_id ?? null,
    lastMessageId: data.messages.at(-1)?.message_id ?? null,
    validation: 'passed',
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});