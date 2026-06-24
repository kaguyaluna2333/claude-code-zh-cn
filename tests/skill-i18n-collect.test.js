const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const collect = require("../plugin/skill-i18n/lib/collect");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-"));
  // 真实 skill
  fs.mkdirSync(path.join(root, "skills", "real"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "real", "SKILL.md"), "---\nname: real\n---\n");
  // 符号链接 skill（指向外部目录）
  const target = path.join(root, "linked-target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "SKILL.md"), "---\nname: linked\n---\n");
  fs.symlinkSync(target, path.join(root, "skills", "linked"), "dir");
  // 用户 command
  fs.mkdirSync(path.join(root, "commands"), { recursive: true });
  fs.writeFileSync(path.join(root, "commands", "c.md"), "---\ndescription: x\n---\n");
  return root;
}

test("collectAll follow=false：跳过符号链接 skill（scan 默认行为）", () => {
  const root = setup();
  const skills = collect.collectAll(root, false).filter((f) => f.kind === "skill");
  assert.equal(skills.length, 1);
  assert.ok(skills[0].path.endsWith("real/SKILL.md"));
});

test("collectAll follow=true：跟随符号链接 skill（restore 总是跟随）", () => {
  const root = setup();
  const skills = collect.collectAll(root, true).filter((f) => f.kind === "skill");
  assert.equal(skills.length, 2); // real + linked
});

test("collectAll 收集 command", () => {
  const root = setup();
  const cmds = collect.collectAll(root, false).filter((f) => f.kind === "command");
  assert.equal(cmds.length, 1);
  assert.ok(cmds[0].path.endsWith("commands/c.md"));
});
