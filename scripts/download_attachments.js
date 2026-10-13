const fs = require('fs');
const path = require('path');

// ============================================================================
// 下载分享对话里的图片附件
//
// 依赖 fetch_share_transcript.js --json 产出的 JSON：
//   node fetch_share_transcript.js <url> out.md --json out.json
//   node download_attachments.js out.json ./images
//
// 为什么需要 THINK 兜底（2026-10-04）：
//   DeepSeek 读图后会在 THINK fragment 里把题面、选项、用户代码逐字复述出来，
//   信息往往已经够用。所以默认 --skip-think-hint 只提示，不阻断。
// ============================================================================

function fail(message) {
  throw new Error(message);
}

function safeName(name, fallback) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  return cleaned || fallback;
}

// 文件魔数：signed_path 失效时服务端会返回 HTML 错误页而不是图片，
// 只看 HTTP 200 会把错误页当成图片存下来（2026-10-04 实测踩到）。
const SIGNATURES = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
  { ext: 'bmp', bytes: [0x42, 0x4d] },
];

function sniffImage(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      // WEBP 还要看第 8..11 位是不是 WEBP
      if (sig.ext === 'webp') {
        const tag = buffer.slice(8, 12).toString('ascii');
        return tag === 'WEBP' ? 'webp' : null;
      }
      return sig.ext;
    }
  }
  return null;
}

async function downloadOne(url, dest, referer) {
  const response = await fetch(url, {
    headers: {
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) {
    fail(`下载失败 HTTP ${response.status}：${url}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  // 先看声明的类型，再验实际魔数，两者都要对
  const declaredImage = contentType.startsWith('image/');
  const sniffed = sniffImage(buffer);
  if (!declaredImage && !sniffed) {
    const preview = buffer.slice(0, 120).toString('utf8').replace(/\s+/g, ' ').slice(0, 100);
    fail(`返回的不是图片（content-type=${contentType || '空'}，前 120 字符：${preview}）。signed_path 可能已失效，需要重新从分享接口取。`);
  }
  if (!sniffed) {
    fail(`content-type 声称是图片（${contentType}）但魔数不匹配，可能是错误页。文件已丢弃。`);
  }

  fs.writeFileSync(dest, buffer);
  return { bytes: buffer.length, format: sniffed, contentType };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    fail('用法：node download_attachments.js <dump.json> [output-dir] [--referer <url>]');
  }

  const refererIndex = args.indexOf('--referer');
  let referer = 'https://chat.deepseek.com/';
  if (refererIndex >= 0) {
    referer = args[refererIndex + 1] || referer;
    args.splice(refererIndex, 2);
  }

  const jsonPath = path.resolve(args[0]);
  const outDir = path.resolve(args[1] || 'deepseek-attachments');
  if (!fs.existsSync(jsonPath)) fail(`找不到 JSON 文件：${jsonPath}`);

  const dump = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const entries = [];
  for (const m of dump.messages || []) {
    for (const f of m.files || []) {
      if (!f.url) continue;
      entries.push({ index: m.index, message_id: m.message_id, name: f.file_name, url: f.url });
    }
  }

  if (entries.length === 0) {
    console.log(JSON.stringify({ outDir, downloaded: 0, note: 'JSON 中没有带下载链接的附件' }, null, 2));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  let ok = 0;
  let failed = 0;

  for (const e of entries) {
    const fallback = `msg${String(e.index).padStart(3, '0')}-${e.message_id}.png`;
    const name = safeName(e.name, fallback);
    // 同名附件加序号，避免互相覆盖
    let dest = path.join(outDir, name);
    let n = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      dest = path.join(outDir, `${stem}-${n}${ext}`);
      n += 1;
    }

    try {
      const info = await downloadOne(e.url, dest, referer);
      ok += 1;
      results.push({
        index: e.index,
        message_id: e.message_id,
        name: e.name,
        file: dest,
        bytes: info.bytes,
        format: info.format,
        status: 'ok',
      });
    } catch (error) {
      failed += 1;
      // 下载失败时不留下半成品
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* 忽略 */ }
      results.push({ index: e.index, message_id: e.message_id, name: e.name, url: e.url, status: 'failed', reason: error.message });
    }
  }

  // 提示：这些图里的题面通常在 THINK 里已经复述过一遍
  const withThinking = (dump.messages || []).filter((m) => m.thinking && m.thinking.trim()).length;

  console.log(JSON.stringify({
    outDir,
    total: entries.length,
    downloaded: ok,
    failed,
    messagesWithThinking: withThinking,
    hint: withThinking > 0
      ? `${withThinking} 条消息带有 THINK 内容，通常已包含图中的题面/选项/代码；读图前先看 THINK，可能不必依赖图片。`
      : '无 THINK 内容，图片里的信息需要自己看。',
    files: results,
  }, null, 2));

  // 全部失败时退出码非 0，便于调用方发现
  if (ok === 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});