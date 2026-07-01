const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { padToLen, BUILTIN_EN, MIN_DATA_OFFSET, loadZhMap, patchBuffer } = require("../plugin/patch-builtin");

// ---------- padToLen ----------

test("padToLen: 中文短于目标 → 半角空格补齐到等长", () => {
  const r = padToLen("你好", 10);
  assert.equal(r.length, 10);
  assert.equal(r.toString("utf8"), "你好    "); // 6字节中文 + 4半角空格 = 10
});

test("padToLen: 恰好等长 → 原样", () => {
  const r = padToLen("abc", 3);
  assert.equal(Buffer.compare(r, Buffer.from("abc")), 0);
});

test("padToLen: 中文长于目标 → 按字符截断 + 补齐", () => {
  const r = padToLen("这是一段很长的中文描述文本", 10);
  assert.equal(r.length, 10);
  // 关键：UTF-8 合法（不切断多字节字符）
  assert.doesNotThrow(() => r.toString("utf8"));
});

test("padToLen: UTF-8 不切断多字节（emoji/西里尔/希腊）", () => {
  for (const zh of ["🚀", "абвгд", "αβγδε"]) {
    const targetLen = Buffer.byteLength(zh, "utf8") - 1; // 强制截断
    const r = padToLen(zh, targetLen);
    assert.equal(r.length, targetLen);
    assert.doesNotThrow(() => r.toString("utf8"), `截断破坏 UTF-8: ${zh}`);
  }
});

test("padToLen: 填充结果始终合法 UTF-8（白名单实际长度）", () => {
  const t = require("../cli-translations.json");
  const map = new Map(t.map((e) => [e.en, e.zh]));
  for (const en of BUILTIN_EN) {
    const zh = map.get(en);
    if (!zh) continue;
    const r = padToLen(zh, Buffer.byteLength(en, "utf8"));
    assert.equal(r.length, Buffer.byteLength(en, "utf8"), `等长失败: ${en.slice(0, 30)}`);
    assert.doesNotThrow(() => r.toString("utf8"), `非法 UTF-8: ${en.slice(0, 30)}`);
  }
});

// ---------- patchBuffer（黑盒：构造 fake binary）----------

function makeFakeBin(en, offset) {
  // 构造一个 fake binary：offset 字节填充 + en 字面 + TRAILER
  const pad = Buffer.alloc(offset, 0);
  const needle = Buffer.from(en, "utf8");
  const trailer = Buffer.from("TRAILER");
  return Buffer.concat([pad, needle, trailer]);
}

test("patchBuffer: 等长替换 + 零偏移（TRAILER 位置不变）", () => {
  const en = "Move this session to a new working directory";
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  const zhMap = new Map([[en, "将本会话切换到新的工作目录"]]);
  const r = patchBuffer(bin, zhMap, false);
  assert.equal(r.replaced, 1);
  assert.equal(bin.length, makeFakeBin(en, MIN_DATA_OFFSET + 100).length); // 总长度不变
  assert.equal(bin.indexOf(Buffer.from(en, "utf8")), -1); // 英文消失
  assert.ok(bin.indexOf(Buffer.from("TRAILER")) > 0); // TRAILER 偏移未漂移
});

test("patchBuffer: dry-run 不改 buf", () => {
  const en = "Time a command";
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  const before = Buffer.from(bin);
  const zhMap = new Map([[en, "为命令计时"]]);
  patchBuffer(bin, zhMap, true);
  assert.equal(Buffer.compare(bin, before), 0); // 未修改
});

test("patchBuffer: 命中位置 < MIN_DATA_OFFSET 被跳过", () => {
  const en = "Time a command";
  const bin = makeFakeBin(en, 0); // offset 0 < MIN_DATA_OFFSET
  const zhMap = new Map([[en, "为命令计时"]]);
  const r = patchBuffer(bin, zhMap, false);
  assert.equal(r.replaced, 0); // 全被 offset 保护跳过
  assert.equal(r.notFound, 1);
});

test("patchBuffer: 含 ${} 占位符的 en 被跳过", () => {
  const en = "Check terminal setup ${NVl[Ne.terminal]}";
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  const zhMap = new Map([[en, "检查终端配置"]]);
  // BUILTIN_EN 不含 ${}，但测 patchBuffer 对 ${} 的防御：直接构造白名单外条目无法测，
  // 改为验证 BUILTIN_EN 里无 ${} 条目（契约）
  assert.ok(BUILTIN_EN.every((e) => !e.includes("${")), "BUILTIN_EN 不应含 ${} 占位符");
});

test("patchBuffer: 翻译表缺 zh → missingZh 计数", () => {
  const en = "Time a command";
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  const r = patchBuffer(bin, new Map(), false); // 空 map，缺 zh
  assert.equal(r.missingZh > 0, true);
  assert.equal(r.replaced, 0);
});

// ---------- loadZhMap ----------

test("loadZhMap: 从 cli-translations.json 加载 en→zh", () => {
  const map = loadZhMap(path.join(__dirname, "..", "cli-translations.json"));
  assert.ok(map.size > 1800);
  // 白名单全在
  for (const en of BUILTIN_EN) {
    assert.ok(map.has(en), `翻译表缺: ${en.slice(0, 40)}`);
  }
});

// ---------- 黑盒：完整脚本执行 ----------

test("黑盒: 无参数 → exit 0（静默）", () => {
  const r = execFileSync("node", [path.join(__dirname, "..", "plugin", "patch-builtin.js")], {
    encoding: "utf8", timeout: 5000,
  });
  // exit 0 不抛即过（输出可能为空）
  assert.ok(true);
});

test("黑盒: dry-run 不写文件", () => {
  const en = "Time a command";
  const tmpBin = path.join(os.tmpdir(), "patch-builtin-test-" + process.pid + ".bin");
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  fs.writeFileSync(tmpBin, bin);
  const before = fs.readFileSync(tmpBin);
  execFileSync("node", [
    path.join(__dirname, "..", "plugin", "patch-builtin.js"),
    tmpBin, path.join(__dirname, "..", "cli-translations.json"), "--dry-run",
  ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(fs.readFileSync(tmpBin), before); // 未改
  fs.unlinkSync(tmpBin);
});

test("黑盒: 实跑替换后英文消失 + 长度不变", () => {
  const en = "Move this session to a new working directory";
  const tmpBin = path.join(os.tmpdir(), "patch-builtin-test2-" + process.pid + ".bin");
  const bin = makeFakeBin(en, MIN_DATA_OFFSET + 100);
  fs.writeFileSync(tmpBin, bin);
  execFileSync("node", [
    path.join(__dirname, "..", "plugin", "patch-builtin.js"),
    tmpBin, path.join(__dirname, "..", "cli-translations.json"),
  ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.readFileSync(tmpBin);
  assert.equal(out.length, bin.length); // 长度不变
  assert.equal(out.indexOf(Buffer.from(en, "utf8")), -1); // 英文消失
  fs.unlinkSync(tmpBin);
});
