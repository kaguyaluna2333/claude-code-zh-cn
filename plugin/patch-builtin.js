#!/usr/bin/env node
// patch-builtin.js — 对 patch-cli.js 扫不到的 builtin 命令描述做「等长 Buffer 替换」补刀
//
// 为什么需要它：patch-cli.js 的 scanStringLiterals 已覆盖 JS 文本段的 "..." 和模板字面量 `...`，
// 但两类盲区扫不到：
//   (B1) 转义引号内嵌："description:\"...\""（对象被序列化成字符串，内层 \" 是内容）
//   (B2) bun data 段：序列化命令定义，不在 JS 文本段
// 这两类里的 builtin 命令描述（/cd、deep-research、/design-sync 等）patch-cli.js 替换不到。
//
// 安全设计：只处理下方 BUILTIN_DESCRIPTIONS 白名单（已确认是 B1/B2 的 builtin 命令描述），
// 不对整个 cli-translations.json 做 indexOf —— 否则会误伤代码标识符/URL/协议文本里的英文片段。
// CC 升级新增 builtin 命令时，在此清单追加 {en, zh} 即可。
//
// 等长原则：中文 UTF-8 不足填全角空格、超长截断，保证不破坏 binary 偏移。
// 含 ${} 占位符的（如 terminal-setup 模板字面量）跳过 —— 占位符结构需专门处理，不在通用流程内。
//
// 协作顺序：patch-cli.js 先跑（处理 JS 文本段）→ 本工具再跑（补刀 B1/B2）。
// 用法：node patch-builtin.js <binary> [--dry-run]

"use strict";

const fs = require("fs");

const binPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

// 无参数时静默退出（exit 0）：本工具被 install.sh / session-start 用 `|| true` 调用，
// 静默退出避免被当成 hook 失败误报；缺参数属于调用方编排问题，不是本工具的错误。
if (!binPath) process.exit(0);

// 已确认的 B1/B2 builtin 命令描述白名单（en=英文原文，zh=中文译文）
// 这些是 patch-cli.js 的 scanStringLiterals 扫不到、需等长 Buffer 补刀的条目
const BUILTIN_DESCRIPTIONS = [
  { en: "Move this session to a new working directory", zh: "将本会话切到新工作目录" },
  { en: "Specify files or directories to analyze (overrides config file)", zh: "指定要分析的文件或目录（覆盖配置文件）" },
  { en: "Set model for this FleetView session (not persisted)", zh: "设置本次FleetView会话的模型（不持久化）" },
  { en: "Run a command immune to hangups", zh: "运行不受挂断影响的命令" },
  { en: "Type checker for Python", zh: "Python类型检查器" },
  { en: "Read the current clipboard contents as text. Requires the `clipboardRead` grant.", zh: "以文本读取当前剪贴板内容。需clipboardRead权限。" },
  { en: "Review a GitHub pull request; for your working diff use /code-review", zh: "审查GitHub PR；本地差异用/code-review" },
  { en: "High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images", zh: "高性能Node.js图像处理，调整JPEG/PNG/WebP等尺寸最快模块" },
  { en: "Queue multiple teach steps in one tool call. Parallels computer_batch: ", zh: "单次工具调用排入多个教学步骤，与computer_batch并行：" },
  { en: "Show one guided-tour tooltip and wait for the user to click Next. On Next, execute the actions, ", zh: "显示引导提示等用户点下一步，点击后执行操作，" },
  { en: "Time a command", zh: "为命令计时" },
  { en: "Run a command with a time limit", zh: "在时限内运行命令" },
  { en: "Wait for a specified duration.", zh: "等待指定时长。" },
  { en: "Write text to the clipboard. Requires the `clipboardWrite` grant.", zh: "写文本到剪贴板。需clipboardWrite权限。" },
  { en: "Authorize design-system access for /design-sync with your claude.ai account", zh: "为 /design-sync 授权 design-system 访问你的 claude.ai 账号" },
  { en: "Authorize design-system access (read and write your organization's claude.ai/design projects) with your claude.ai account. This is separate from this session's authentication and changes nothing else.", zh: "授权 design-system 访问（读写你组织的 claude.ai/design 项目）你的 claude.ai 账号。这与本会话的认证相互独立，不改变其他任何设置。" },
  { en: "Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it. Use when the user runs /design-sync or says \"sync my design system to Claude Design\".", zh: "将 React 设计系统推送到 claude.ai/design。运行转换器打包真实组件代码（来自 Storybook 或裸包）并上传。当用户运行 /design-sync 或说“同步设计系统到 Claude Design”时使用。" },
  { en: "Deep research harness \\u2014 fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.", zh: "深度研究框架 \\u2014 并行网络搜索、抓取来源、对抗式验证论断、综合出带引用的报告。" },
];

// 等长填充/截断：让中文 UTF-8 字节数 == 目标长度
// 用 ASCII 半角空格（1 字节）填充——永不切断多字节字符，任何 targetLen 都得到合法 UTF-8
function padToLen(zhStr, targetLen) {
  let b = Buffer.from(zhStr, "utf8");
  if (b.length === targetLen) return b;
  if (b.length < targetLen) {
    const pad = " ".repeat(targetLen - b.length);
    return Buffer.from(zhStr + pad, "utf8");
  }
  // 中文比英文长：按字符截断（保证 UTF-8 完整），再用半角空格补齐
  let s = zhStr;
  while (Buffer.byteLength(s, "utf8") > targetLen) s = s.slice(0, -1);
  b = Buffer.from(s, "utf8");
  if (b.length < targetLen) {
    const pad = " ".repeat(targetLen - b.length);
    b = Buffer.from(s + pad, "utf8");
  }
  return b;
}

const buf = fs.readFileSync(binPath);
let totalReplaced = 0;
let notFound = 0;
let lenMismatch = 0;
const touched = [];

for (const { en, zh } of BUILTIN_DESCRIPTIONS) {
  if (en.includes("${")) continue; // 占位符需专门处理，跳过
  const enBuf = Buffer.from(en, "utf8");
  const zhBuf = padToLen(zh, enBuf.length);
  if (zhBuf.length !== enBuf.length) { lenMismatch++; continue; }
  let count = 0;
  let idx = 0;
  const positions = [];
  // Mach-O 头部 + LOAD commands 在文件前部（保守取 16KB），bun __bun 文本段在靠后位置。
  // 白名单是长描述句（30+ 字节），不会出现在头部；跳过 < MIN_DATA_OFFSET 的命中，
  // 防止误改 Mach-O 结构（非完整段级验证，依赖白名单长描述 + bun 段布局特性）。
  const MIN_DATA_OFFSET = 16384;
  while ((idx = buf.indexOf(enBuf, idx)) !== -1) {
    if (idx >= MIN_DATA_OFFSET) positions.push(idx);
    idx += enBuf.length;
  }
  if (positions.length === 0) { notFound++; continue; }
  if (!dryRun) {
    for (const p of positions) zhBuf.copy(buf, p);
  }
  count = positions.length;
  totalReplaced += count;
  touched.push({ en: en.slice(0, 40), zh: zh.slice(0, 18), count });
}

if (!dryRun && totalReplaced > 0) {
  // 原子写：写 .tmp（保留原文件权限）→ rename，避免半写损坏 binary
  const tmp = binPath + ".zh-cn-tmp." + process.pid;
  fs.writeFileSync(tmp, buf);
  try { fs.chmodSync(tmp, fs.statSync(binPath).mode); } catch {}
  try { fs.renameSync(tmp, binPath); }
  catch {
    // NTFS/EBUSY 兜底：先删目标再 rename（与 patch-cli.js 的 safeWrite 一致）
    try { fs.unlinkSync(binPath); } catch {}
    fs.renameSync(tmp, binPath);
  }
}

console.error(`[patch-builtin] ${dryRun ? "dry-run " : ""}白名单 ${BUILTIN_DESCRIPTIONS.length} 条：替换 ${totalReplaced} 处，未找到 ${notFound}，长度不匹配 ${lenMismatch}`);
if (process.env.VERBOSE) {
  for (const t of touched) console.error(`  ✓ ${t.en.padEnd(42)} → ${t.zh} (${t.count}处)`);
}
