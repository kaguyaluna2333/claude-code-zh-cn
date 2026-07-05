#!/usr/bin/env node
// patch-builtin.js — 对 patch-cli.js 扫不到的 builtin 命令描述做「等长 Buffer 替换」补刀
//
// 为什么需要它：patch-cli.js 的 scanStringLiterals 已覆盖 JS 文本段的 "..." 和模板字面量 `...`，
// 但两类盲区扫不到：
//   (B1) 转义引号内嵌："description:\"...\""（对象被序列化成字符串，内层 \" 是内容）
//   (B2) bun data 段：序列化命令定义，不在 JS 文本段
//
// 数据源单一（项目原则）：zh 译文从 cli-translations.json 读取，本文件只维护 en 白名单
// （已确认是 B1/B2 的 builtin 命令描述原文）。CC 升级新增 builtin 命令时，在白名单 + 翻译表各加一条。
//
// 安全：等长替换（中文不足填半角空格、超长截断），保留 ${} 占位符（跳过含 ${} 的条目），
// 跳过 < MIN_DATA_OFFSET 的命中（Mach-O 头部 LOAD 区），原子写 + codesign 验签由调用方（install.sh/session-start）处理。
//
// 协作顺序：patch-cli.js 先跑（处理 JS 文本段）→ 本工具再跑（补刀 B1/B2）。已被 patch-cli.js
// 替换的英文在 binary 里已不存在，本工具 indexOf 不到、自然跳过，不冲突。
//
// 用法：node patch-builtin.js <binary> [translations.json] [--dry-run]
//   translations.json 默认 ../cli-translations.json（相对本文件）

"use strict";

const fs = require("fs");
const path = require("path");

// 已确认的 B1/B2 builtin 命令描述英文原文白名单（zh 从 translations.json 查）
const BUILTIN_EN = [
  "Move this session to a new working directory",
  "Specify files or directories to analyze (overrides config file)",
  "Set model for this FleetView session (not persisted)",
  "Run a command immune to hangups",
  "Type checker for Python",
  "Read the current clipboard contents as text. Requires the `clipboardRead` grant.",
  "Review a GitHub pull request; for your working diff use /code-review",
  "High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images",
  "Queue multiple teach steps in one tool call. Parallels computer_batch: ",
  "Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, ",
  "Time a command",
  "Run a command with a time limit",
  "Wait for a specified duration.",
  "Write text to the clipboard. Requires the `clipboardWrite` grant.",
  "Authorize design-system access for /design-sync with your claude.ai account",
  "Authorize design-system access (read and write your organization's claude.ai/design projects) with your claude.ai account. This is separate from this session's authentication and changes nothing else.",
  "Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user runs /design-sync or says \"sync my design system to Claude Design\".",
  "Deep research harness \\u2014 fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.",
  // 2.1.201 新增 builtin 命令（B1 转义引号内嵌）
  "Open Claude in Chrome settings",
  "Grant or revoke Claude agent access to your Design projects",
  "Grant Claude agent access to your Design projects",
  "Revoke Claude agent access to your Design projects",
  "Show which loaded skills are unused and costing context",
];

// Mach-O 头部 + LOAD commands 在文件前部，bun __bun 文本段在靠后位置。
// 跳过 < MIN_DATA_OFFSET 的命中，防止误改 Mach-O 结构（白名单是长描述句，不会出现在头部）。
const MIN_DATA_OFFSET = 16384;

// 等长填充/截断：让中文 UTF-8 字节数 == 目标长度。
// 用 ASCII 半角空格（1 字节）填充——永不切断多字节字符，任何 targetLen 都得到合法 UTF-8。
function padToLen(zhStr, targetLen) {
  let b = Buffer.from(zhStr, "utf8");
  if (b.length === targetLen) return b;
  if (b.length < targetLen) {
    const pad = " ".repeat(targetLen - b.length);
    return Buffer.from(zhStr + pad, "utf8");
  }
  let s = zhStr;
  while (Buffer.byteLength(s, "utf8") > targetLen) s = s.slice(0, -1);
  b = Buffer.from(s, "utf8");
  if (b.length < targetLen) {
    const pad = " ".repeat(targetLen - b.length);
    b = Buffer.from(s + pad, "utf8");
  }
  return b;
}

// 从 translations.json 构建 en→zh map
function loadZhMap(translationsPath) {
  const t = JSON.parse(fs.readFileSync(translationsPath, "utf8"));
  const m = new Map();
  for (const e of t) if (e.en && e.zh) m.set(e.en, e.zh);
  return m;
}

// 对 buf 做 builtin 补刀替换。返回 { replaced, notFound, lenMismatch, missingZh, touched }。
function patchBuffer(buf, zhMap, dryRun) {
  let replaced = 0, notFound = 0, lenMismatch = 0, missingZh = 0;
  const touched = [];
  for (const en of BUILTIN_EN) {
    if (en.includes("${")) continue; // 占位符需专门处理，跳过
    const zh = zhMap.get(en);
    if (!zh) { missingZh++; continue; }
    const enBuf = Buffer.from(en, "utf8");
    const zhBuf = padToLen(zh, enBuf.length);
    if (zhBuf.length !== enBuf.length) { lenMismatch++; continue; }
    const positions = [];
    let idx = 0;
    while ((idx = buf.indexOf(enBuf, idx)) !== -1) {
      if (idx >= MIN_DATA_OFFSET) positions.push(idx);
      idx += enBuf.length;
    }
    if (positions.length === 0) { notFound++; continue; }
    if (!dryRun) for (const p of positions) zhBuf.copy(buf, p);
    replaced += positions.length;
    touched.push({ en: en.slice(0, 40), zh: zh.slice(0, 18), count: positions.length });
  }
  return { replaced, notFound, lenMismatch, missingZh, touched };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("-"));
  const binPath = positional[0];
  const dryRun = args.includes("--dry-run");
  // translations 路径：显式参数 > 同目录（安装态扁平结构）> ../（项目源 plugin/ 的父目录）
  const translationsPath = positional[1]
    || (fs.existsSync(path.join(__dirname, "cli-translations.json"))
      ? path.join(__dirname, "cli-translations.json")
      : path.join(__dirname, "..", "cli-translations.json"));

  // 无 binary 参数时静默退出（exit 0）：本工具被 install.sh / session-start 用 `|| true` 调用，
  // 静默退出避免被当成 hook 失败误报；缺参数属于调用方编排问题，不是本工具的错误。
  if (!binPath) process.exit(0);

  let zhMap;
  try { zhMap = loadZhMap(translationsPath); }
  catch { console.error("[patch-builtin] 无法读取翻译表，跳过"); process.exit(0); }

  const buf = fs.readFileSync(binPath);
  const r = patchBuffer(buf, zhMap, dryRun);

  if (!dryRun && r.replaced > 0) {
    // 原子写：写 .tmp（保留原文件权限）→ rename，避免半写损坏 binary
    const tmp = binPath + ".zh-cn-tmp." + process.pid;
    fs.writeFileSync(tmp, buf);
    try { fs.chmodSync(tmp, fs.statSync(binPath).mode); } catch {}
    try { fs.renameSync(tmp, binPath); }
    catch {
      // NTFS/EBUSY 兜底：先删目标再 rename（与 patch-cli.js 的原子写一致）
      try { fs.unlinkSync(binPath); } catch {}
      fs.renameSync(tmp, binPath);
    }
  }

  console.error(`[patch-builtin] ${dryRun ? "dry-run " : ""}白名单 ${BUILTIN_EN.length} 条：替换 ${r.replaced}，未找到 ${r.notFound}，长度不匹配 ${r.lenMismatch}，翻译表缺 zh ${r.missingZh}`);
  if (process.env.VERBOSE) {
    for (const t of r.touched) console.error(`  ✓ ${t.en.padEnd(42)} → ${t.zh} (${t.count}处)`);
  }
}

if (require.main === module) main();

module.exports = { padToLen, BUILTIN_EN, MIN_DATA_OFFSET, loadZhMap, patchBuffer };
