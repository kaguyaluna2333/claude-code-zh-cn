// lib/collect.js — skill/command/metadata 文件发现（单一来源，scan 与 restore 共用）
// 避免两处目录遍历逻辑各自漂移（如符号链接默认值曾因此不一致）。

"use strict";

const fs = require("fs");
const path = require("path");

function tryReadDir(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function collectUserSkills(root, acceptDir) {
  const out = [];
  for (const base of [path.join(root, "skills"), path.join(root, ".claude", "skills")]) {
    for (const e of tryReadDir(base)) {
      if (acceptDir(e)) {
        const f = path.join(base, e.name, "SKILL.md");
        if (exists(f)) out.push({ path: f, kind: "skill" });
      }
    }
  }
  return out;
}

function collectUserCommands(root) {
  const out = [];
  for (const base of [path.join(root, "commands"), path.join(root, ".claude", "commands")]) {
    for (const e of tryReadDir(base)) {
      if (e.isFile() && e.name.endsWith(".md")) out.push({ path: path.join(base, e.name), kind: "command" });
    }
  }
  return out;
}

// 插件 cache skill/command：root/plugins/cache/<marketplace>/<plugin>/<version>/{skills,commands}
function collectPluginMarkdown(root, acceptDir) {
  const out = [];
  const cacheBase = path.join(root, "plugins", "cache");
  for (const mp of tryReadDir(cacheBase)) {
    if (!mp.isDirectory()) continue;
    const mpDir = path.join(cacheBase, mp.name);
    for (const plugin of tryReadDir(mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(mpDir, plugin.name);
      for (const ver of tryReadDir(pluginDir)) {
        if (!ver.isDirectory()) continue;
        const p = path.join(pluginDir, ver.name);
        for (const s of tryReadDir(path.join(p, "skills"))) {
          if (acceptDir(s)) {
            const f = path.join(p, "skills", s.name, "SKILL.md");
            if (exists(f)) out.push({ path: f, kind: "skill" });
          }
        }
        for (const c of tryReadDir(path.join(p, "commands"))) {
          if (c.isFile() && c.name.endsWith(".md")) out.push({ path: path.join(p, "commands", c.name), kind: "command" });
        }
      }
    }
  }
  return out;
}

// 插件元数据 JSON：plugin.json（cache 下）+ marketplace.json（cache 下 + marketplaces 下）
function collectMetadata(root) {
  const out = [];
  const seen = new Set();
  const add = (p) => { if (exists(p) && !seen.has(p)) { seen.add(p); out.push({ path: p, kind: "metadata" }); } };
  const cacheBase = path.join(root, "plugins", "cache");
  for (const mp of tryReadDir(cacheBase)) {
    if (!mp.isDirectory()) continue;
    const mpDir = path.join(cacheBase, mp.name);
    for (const plugin of tryReadDir(mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(mpDir, plugin.name);
      for (const ver of tryReadDir(pluginDir)) {
        if (!ver.isDirectory()) continue;
        const cp = path.join(pluginDir, ver.name, ".claude-plugin");
        add(path.join(cp, "plugin.json"));
        add(path.join(cp, "marketplace.json"));
      }
    }
  }
  const mpBase = path.join(root, "plugins", "marketplaces");
  for (const m of tryReadDir(mpBase)) {
    if (!m.isDirectory()) continue;
    add(path.join(mpBase, m.name, ".claude-plugin", "marketplace.json"));
  }
  return out;
}

// 统一收集所有来源。followSymlinks 控制是否跟随符号链接目录。
function collectAll(root, followSymlinks) {
  const acceptDir = (e) => e.isDirectory() || (followSymlinks && e.isSymbolicLink());
  return [
    ...collectUserSkills(root, acceptDir),
    ...collectUserCommands(root),
    ...collectPluginMarkdown(root, acceptDir),
    ...collectMetadata(root),
  ];
}

module.exports = { collectAll, collectUserSkills, collectUserCommands, collectPluginMarkdown, collectMetadata };
