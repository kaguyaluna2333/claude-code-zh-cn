# 实现计划：Skill / 插件 `/` 命令说明自动汉化

## Overview

为 `claude-code-zh-cn` 插件新增一条「Skill/插件 `/` 命令说明自动汉化」流水线。CC 每次启动时，通过现有的 `SessionStart` hook **后台异步**扫描 `~/.claude/{skills,commands}` 与 `plugins/cache/`，把新装的 skill/插件的 `description` 翻译成中文并写回 frontmatter（备份原文、可逆）。翻译引擎可配置：默认 `claude --bare`（零配置），配 API key 后自动切 GLM/OpenAI 兼容（更快）。

目标：新装 skill/插件后，CC **下次启动**自动汉化其 `/` 命令说明；不破坏源文件、不因插件更新丢失译文、可一键还原。

详细背景与全部技术决策见 `~/.claude/plans/https-github-com-kaguyaluna2333-claude-c-staged-stonebraker.md`（已批准的高层方案）。本文档把它切成**垂直可验证的任务**。

## Architecture Decisions

- **复用现有 SessionStart hook**：在 `plugin/hooks/session-start` 末尾（第 717 行 `repair_settings_from_cache` 后）后台 `&` 调用独立流水线，不新增 hooks.json 注册、不阻塞会话启动。
- **写回 = 行级 patch，绝不重序列化 frontmatter**：只改 `description` 行 + 追加 `description_en` 备份 + `x-zh-cn-translated: true` 标记；正文 byte-for-byte 不变。统一改写为单行 double-quoted 以兼容跨行 `>`/`|` 块。
- **全局译文缓存（hash key）**：`sha256(英文.trim().toLowerCase())` → 中文。插件 `update` 覆盖 cache 后标记丢失，查缓存命中直接重应用、不重调 LLM。
- **零外部 node 依赖**：frontmatter 手写解析（不引 js-yaml）；HTTP 用内置 `https`；调 claude 用 `child_process`。无 `package.json`。
- **可逆 + 安全**：原文备份；翻译失败绝不写回（源文件永不损坏）；`restore.js` 一键还原，`uninstall.sh` 自动调用。
- **契合项目约定**（`CLAUDE.md`）：数据单一来源（缓存是运行时产物，不进 repo）；术语保留英文（写进翻译 prompt）；发布走 manifest→CHANGELOG→tag→release→preflight。

## 依赖图

```
lib/frontmatter.js ─┬─→ scan.js ──┐
lib/cjk.js ─────────┘             ├─→ translate-skills.sh ──→ session-start hook
lib/cache.js ─┬─→ scan.js          │        (入口编排)
             └─→ translate.js ─────┘
                                  apply.js   (写回 md/json)
                                  restore.js ─→ uninstall.sh
```

实现顺序自底向上：先 frontmatter/cjk 基础 → 打通最小流水线 → 加固（缓存、全范围、provider）→ 自动触发与可逆 → 工程化发布。

---

## Task List

### Phase 1: 最小端到端 happy path

#### Task 1: frontmatter 基础解析/写回 + CJK 检测 + 单测

**Description:** 实现 frontmatter 解析与写回的核心库（先覆盖最常见的 plain 与双引号两种值风格），以及 CJK 字符比例检测工具，配单测。这是被 scan/apply/restore 共享的基础。

**Acceptance criteria:**
- [ ] `lib/frontmatter.js` 能解析 `---\n...\n---` frontmatter，提取 `description`（plain 与 `"..."` 双引号两种风格），记录值行范围、style、`bodyStart` 偏移
- [ ] `rewriteDescription(text, zh, en)` 写回后：`description` 改为单行 double-quoted 中文，追加 `description_en` 与 `x-zh-cn-translated: true`，**frontmatter 其余字段与正文 byte-for-byte 不变**
- [ ] `lib/cjk.js` 的 `cjkRatio(s)` 正确返回 CJK 字符占比
- [ ] 单测覆盖 plain / double-quoted / 无 frontmatter / 空 frontmatter 四种 case 的 parse + rewrite 往返无损

**Verification:**
- [ ] `node --test tests/skill-i18n-frontmatter.test.js` 通过
- [ ] `node --test tests/skill-i18n-cjk.test.js` 通过
- [ ] `node --check plugin/skill-i18n/lib/frontmatter.js`、`node --check plugin/skill-i18n/lib/cjk.js` 无语法错误

**Dependencies:** None

**Files likely touched:**
- `plugin/skill-i18n/lib/frontmatter.js`（新建）
- `plugin/skill-i18n/lib/cjk.js`（新建）
- `tests/skill-i18n-frontmatter.test.js`（新建）
- `tests/skill-i18n-cjk.test.js`（新建）

**Estimated scope:** M（4 文件）

---

#### Task 2: scan + translate(claude) + apply + bash 入口，打通单 skill

**Description:** 实现流水线三阶段脚本与 bash 入口，打通「扫描一个目录 → claude CLI 翻译 → 写回 frontmatter」的最短路径。支持 `--scan-root`/`--dry-run` 手动调试。先只扫 `skills/*/SKILL.md`。

**Acceptance criteria:**
- [ ] `scan.js` 扫描给定根下的 `*/SKILL.md`，解析 frontmatter，输出待翻译队列 JSON（跳过无 description、已是中文 `cjkRatio>0.3`、已标记的）
- [ ] `translate.js` 实现 claude provider：`spawn("claude",["--bare","-p",prompt,"--output-format","text"])`，批量翻译（带编号 JSON），解析返回的 `{id:译文}`
- [ ] `apply.js` 安全写回（先 `.tmp` 再 `renameSync`，参考 `patch-cli.js` 第 981-988 行）
- [ ] `translate-skills.sh` 编排 scan→translate→apply，`set -uo pipefail`（不加 `-e`），`--dry-run` 只列队列不翻译
- [ ] 翻译 prompt 明确：只输出 JSON、保留 `${}`/`$ARGUMENTS`/命令名/API/PR 等不译

**Verification:**
- [ ] 造 `/tmp/zh-cn-test/.claude/skills/test-skill/SKILL.md`（英文 plain description）
- [ ] `--dry-run` 列出该 skill 待翻译
- [ ] 实跑后 `head -6 SKILL.md` 显示：description 中文、`description_en` 备份、`x-zh-cn-translated: true`、正文不变
- [ ] `node --check` 四个 `.js` + `bash -n translate-skills.sh` 无错误

**Dependencies:** Task 1

**Files likely touched:**
- `plugin/skill-i18n/scan.js`（新建）
- `plugin/skill-i18n/translate.js`（新建）
- `plugin/skill-i18n/apply.js`（新建）
- `plugin/skill-i18n/translate-skills.sh`（新建）

**Estimated scope:** M（4 文件）

---

### ✅ Checkpoint 1: 最小端到端跑通

- [ ] `--scan-root` 模式下，一个英文 plain SKILL.md 被正确翻译写回，正文无损，重跑识别为已译（0 待翻译）
- [ ] 所有新 `.js` `node --check` 通过，新测试 `node --test` 通过
- [ ] **人工 review 后再进入 Phase 2**

---

### Phase 2: frontmatter 健壮性 + 缓存

#### Task 3: frontmatter 扩展（单引号 / `>` 折叠 / `|` 字面块）+ 写前自检

**Description:** 扩展 frontmatter 解析以覆盖真实世界的复杂 case（ponytail 用 `>` 折叠块、含嵌套引号），并加写前自检防止破坏 skill。

**Acceptance criteria:**
- [ ] 解析支持单引号 `'...'`、`>`/`>-` 折叠块（换行→空格）、`|`/`|-` 字面块（保留换行）
- [ ] 写回 block scalar 时删除原多行值范围、在 `description:` 行写单行新值
- [ ] 写前自检：rewrite 后重新 parse，确认 `description_en` == 原文且正文 md5 不变，否则放弃写回
- [ ] 单测新增 single-quoted / folded / literal / 嵌套引号 case

**Verification:**
- [ ] `node --test tests/skill-i18n-frontmatter.test.js` 全绿（含新 case）
- [ ] 用 ponytail 的真实 `>` 块 SKILL.md 做往返测试：翻译→写回→还原，frontmatter 其余部分与正文不变

**Dependencies:** Task 1

**Files likely touched:**
- `plugin/skill-i18n/lib/frontmatter.js`（扩展）
- `tests/skill-i18n-frontmatter.test.js`（加 case）

**Estimated scope:** S（2 文件）

---

#### Task 4: 全局译文缓存 + 增量逻辑 + 单测

**Description:** 实现 `lib/cache.js`（hash key 的译文缓存，原子写），并把增量判定接入 scan：原文命中缓存则入「直接应用」队列，不调 LLM。

**Acceptance criteria:**
- [ ] `lib/cache.js` 读写 `~/.claude/plugins/claude-code-zh-cn/.skill-i18n-cache/translations.json`，结构 `{version, entries:{hash:{en,zh,ts,provider}}}`
- [ ] key = `sha256(en.trim().toLowerCase())`；原子写 `.tmp`→`rename`
- [ ] scan 接入缓存：已标记且校验通过→跳过；原文命中缓存→直接应用队列；全新原文→待翻译队列（hash 去重）
- [ ] translate 命中缓存不调 LLM，翻译成功后写缓存
- [ ] 单测覆盖缓存读写、hash 命中、原子写

**Verification:**
- [ ] `node --test tests/skill-i18n-cache.test.js` 通过
- [ ] 手动：翻译一个 skill 后删掉其 frontmatter 标记（模拟插件 update 覆盖），重跑 scan 应走「缓存命中直接应用」、不调 claude

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `plugin/skill-i18n/lib/cache.js`（新建）
- `plugin/skill-i18n/scan.js`（接入缓存）
- `plugin/skill-i18n/translate.js`（读写缓存）
- `tests/skill-i18n-cache.test.js`（新建）

**Estimated scope:** M（4 文件）

---

### ✅ Checkpoint 2: 健壮性 + 缓存

- [ ] ponytail `>` 块等硬 case 正确翻译写回无损
- [ ] 缓存命中场景不重调 LLM（模拟覆盖后重应用）
- [ ] 新测试全绿

---

### Phase 3: 全范围 + API provider

#### Task 5: 扫描范围扩展 + JSON 元数据写回

**Description:** 扩展 scan 到全局 commands、插件 cache 内的 skill/command、以及 plugin.json/marketplace.json 元数据；apply 支持 JSON 写回（备份 `_description_en` + `_zh_cn_translated`）。

**Acceptance criteria:**
- [ ] scan 覆盖：`~/.claude/commands/*.md`、`plugins/cache/*/*/*/{skills/*/SKILL.md, commands/*.md}`、`.../.claude-plugin/{plugin,marketplace}.json`
- [ ] marketplace.json 的 `plugins[].description` 逐项处理；项目级 `$cwd/.claude/` 默认关（`ZH_CN_SKILL_I18N_INCLUDE_PROJECT=1` 开）
- [ ] apply 对 JSON：替换 `description`，同对象插入 `_description_en` + `_zh_cn_translated: true`，只处理 `.claude-plugin/` 下这两个文件
- [ ] command 的 `argument-hint` 默认不译（`ZH_CN_SKILL_I18N_TRANSLATE_ARGHINT=1` 才译）

**Verification:**
- [ ] `--scan-root` 指向一个含 commands/ 和模拟 .claude-plugin/ 的测试树，确认都被扫描入队
- [ ] 实跑后 plugin.json 的 description 中文化、`_description_en` 备份在、JSON 仍合法（`node -e JSON.parse`）
- [ ] 命令 md 的 description 中文化、argument-hint 默认保留原样

**Dependencies:** Task 2, Task 4

**Files likely touched:**
- `plugin/skill-i18n/scan.js`（扩展来源）
- `plugin/skill-i18n/apply.js`（JSON 写回分支）

**Estimated scope:** M（2 文件，改动较大）

---

#### Task 6: GLM/OpenAI 兼容 provider + 选择逻辑

**Description:** 在 translate.js 加 GLM/OpenAI 兼容 provider（手写 `https.request`），实现 `auto/claude/glm/openai` 选择逻辑。

**Acceptance criteria:**
- [ ] OpenAI 兼容 provider：POST `{baseURL}/chat/completions`，`Authorization: Bearer <key>`，解析 `choices[0].message.content`（去 markdown fence 后 JSON.parse）
- [ ] provider 选择：`auto`（有 key→API，无→claude）/ `claude` / `glm` / `openai`
- [ ] `glm` 默认 `baseURL=https://open.bigmodel.cn/api/paas/v4`、`model=glm-4.5-flash`
- [ ] 容错：JSON.parse 失败→去 fence 重试→降级逐条→再失败跳过记日志（不写回任何文件）
- [ ] 环境变量：`ZH_CN_SKILL_I18N_PROVIDER/API_KEY/BASE_URL/MODEL`

**Verification:**
- [ ] 无 key 时 `auto` 退回 claude（日志/行为确认）
- [ ] 有 GLM key 时批量翻译成功、写缓存、apply 写回（用 /tmp 测试树）
- [ ] 故意给错 key → 该批跳过、不写坏文件、下次可重试

**Dependencies:** Task 4

**Files likely touched:**
- `plugin/skill-i18n/translate.js`（扩展 provider）

**Estimated scope:** M（1 文件，改动较大）

---

### ✅ Checkpoint 3: 全范围 + API provider

- [ ] 真实 `~/.claude` 全量汉化：先 `cp -r ~/.claude/skills ~/.claude/skills.bak`
- [ ] 跑流水线，`diff -r` 确认**只改 frontmatter**（skill/command）+ 元数据 description
- [ ] `node restore.js --all` 后 `diff -r` 应无差异，`rm -rf ~/.claude/skills.bak`
- [ ] 启动 CC 按 `/` 确认列表显示中文

---

### Phase 4: 自动触发 + 可逆 + 边界

#### Task 7: session-start hook 集成（后台异步 + 超时）

**Description:** 把流水线挂到 `plugin/hooks/session-start`，后台 `&` 异步执行，超时 kill 保护，`ZH_CN_SKILL_I18N_DISABLE` 一键禁用。

**Acceptance criteria:**
- [ ] 在 `plugin/hooks/session-start` 第 717 行 `repair_settings_from_cache` 后、`read -r INPUT` 前插入后台调用块
- [ ] 后台子 shell 调 `translate-skills.sh`，`disown` 防止 SIGHUP，`sleep $timeout; kill` 兜底
- [ ] `ZH_CN_SKILL_I18N_DISABLE=1` 完全跳过；`ZH_CN_SKILL_I18N_TIMEOUT` 可配（默认 25）
- [ ] 不破坏现有 additionalContext JSON 输出（hook 末尾的 `cat <<HOOK_OUTPUT` 仍正常）

**Verification:**
- [ ] `bash -n plugin/hooks/session-start` 语法 OK
- [ ] 现有 `tests/session-start-hook.test.js` 仍通过
- [ ] 手动：临时造一个新英文 skill，模拟 hook 调用（`CLAUDE_PLUGIN_ROOT=... ZH_CN_SKILL_I18N_HOOK=1 bash session-start < /dev/null`），确认后台翻译被触发、hook 立即返回 JSON

**Dependencies:** Task 5, Task 6

**Files likely touched:**
- `plugin/hooks/session-start`（插入 ~9 行）

**Estimated scope:** S（1 文件）

---

#### Task 8: restore.js + uninstall.sh 集成

**Description:** 实现还原脚本（`description_en`→`description`、删标记），并接入 uninstall.sh（删插件目录前调用）。

**Acceptance criteria:**
- [ ] `restore.js --scan-root <dir>` / `--all` 扫描所有来源，还原 md 与 JSON（含已卸载插件的残留路径自动跳过）
- [ ] md：`description = description_en`，删 `description_en` 与 `x-zh-cn-translated`；JSON 同理用 `_` 前缀字段
- [ ] 缓存 `translations.json` 保留（重装可复用）
- [ ] `uninstall.sh` 第 278 行 `rm -rf "$PLUGIN_DST"` 前插入 `node restore.js --all || true`

**Verification:**
- [ ] 对 Checkpoint 3 汉化过的树跑 `restore.js`，`diff` 与原始一致
- [ ] `bash -n uninstall.sh` 语法 OK
- [ ] 模拟卸载流程：restore 被调用、所有标记清除

**Dependencies:** Task 5

**Files likely touched:**
- `plugin/skill-i18n/restore.js`（新建）
- `uninstall.sh`（插入还原调用）

**Estimated scope:** S（2 文件）

---

#### Task 9: 边界情况收尾

**Description:** 补齐边界：符号链接跟随/跳过、占位符校验、只读权限、幂等等。

**Acceptance criteria:**
- [ ] 符号链接 skill：默认 `fs.realpathSync` 跟随改真实文件；`ZH_CN_SKILL_I18N_FOLLOW_SYMLINKS=0` 跳过
- [ ] 写回后校验译文保留所有 `${...}` 占位符（en/zh 出现次数相等），不等则丢弃该译文、下次重试
- [ ] 只读/无写权限文件：写失败记日志跳过，不中断
- [ ] 重复运行幂等（标记+备份+缓存三重保证）

**Verification:**
- [ ] addy 符号链接 skill 测试：跟随模式改到真实文件、跳过模式不动
- [ ] 含 `${VAR}` 的 description：译文保留占位符，校验通过
- [ ] 连跑 3 次流水线，第 2、3 次 0 待翻译、0 写回

**Dependencies:** Task 5, Task 8

**Files likely touched:**
- `plugin/skill-i18n/scan.js`、`apply.js`（边界分支）

**Estimated scope:** S（2 文件）

---

### ✅ Checkpoint 4: 自动触发 + 可逆 + 边界

- [ ] 新装一个 skill 后重启 CC，下次启动自动汉化（日志/结果确认）
- [ ] `uninstall.sh` 完整跑通后所有翻译还原为英文
- [ ] 符号链接/占位符/幂等边界全部通过

---

### Phase 5: 工程化 + 发布

#### Task 10: preflight 集成

**Description:** 把新增脚本纳入 preflight 的语法检查，确保 CI 守住质量。

**Acceptance criteria:**
- [ ] `scripts/preflight.sh` Shell 段（第 91 行后）加 `run bash -n plugin/skill-i18n/translate-skills.sh`
- [ ] JS 段（第 114 行后）加 6 个新 `.js` 的 `node --check`
- [ ] 新测试被现有 `node --test tests/*.test.js` 自动覆盖

**Verification:**
- [ ] `bash scripts/preflight.sh --skip-payload-source` 全绿
- [ ] 故意引入语法错误，确认 preflight 能捕获

**Dependencies:** Task 1–9

**Files likely touched:**
- `scripts/preflight.sh`（追加检查项）

**Estimated scope:** XS（1 文件）

---

#### Task 11: 文档

**Description:** 写用户文档：README 新章节、skill-i18n/README、环境变量表、可逆性说明。

**Acceptance criteria:**
- [ ] `plugin/skill-i18n/README.md`：功能说明 + 完整环境变量表 + 可逆性 + 禁用开关 + 已知权衡（影响 model 触发）
- [ ] 项目 `README.md` 新增「Skill/插件命令说明汉化」章节，链接到 skill-i18n/README
- [ ] 文档说明：默认 claude CLI 开箱即用；配 key 更快；下次启动生效（最终一致性）

**Verification:**
- [ ] 环境变量表与代码实现一致（逐项核对默认值）
- [ ] 明确告知 description 改中文会影响 model 自动触发 skill（权衡透明）

**Dependencies:** Task 6, Task 9

**Files likely touched:**
- `plugin/skill-i18n/README.md`（新建）
- `README.md`（加章节）

**Estimated scope:** S（2 文件）

---

#### Task 12: 版本发布

**Description:** 按 CLAUDE.md 发布流程升版本、记 CHANGELOG、打 tag。

**Acceptance criteria:**
- [ ] `plugin/manifest.json` version 2.4.61 → 2.5.0
- [ ] `CHANGELOG.md` 顶部新增 2.5.0 段（新增：Skill/插件命令说明自动汉化）
- [ ] （经人工确认后）`git tag v2.5.0` + `gh release create` + `preflight.sh --release-state`

**Verification:**
- [ ] `bash scripts/preflight.sh --release-state` 通过
- [ ] manifest / CHANGELOG / tag / Release 对齐

**Dependencies:** Task 10, Task 11

**Files likely touched:**
- `plugin/manifest.json`
- `CHANGELOG.md`

**Estimated scope:** XS（2 文件）

---

### ✅ Checkpoint 5: 可发布

- [ ] `bash scripts/preflight.sh --release-state` 全绿
- [ ] 端到端：装插件 → 新装 skill → 重启 CC → `/` 列表中文 → uninstall 全还原
- [ ] 人工 review 后打 tag 发 Release

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 写回 frontmatter 破坏 skill 可用性 | 高 | 行级 patch 不重序列化 + 写前自检（正文 md5 不变才写）+ 单测覆盖所有 case |
| description 改中文影响 model 自动触发 skill | 中 | 备份 `description_en` 可逆 + 一键禁用 + `restore.js` 全量还原 + README 明示权衡 |
| 首次翻译几十个 skill 较慢（claude 引擎） | 中 | 后台异步不阻塞 + 批量翻译 + 缓存 + 配 GLM key 加快 |
| 插件 update 覆盖 cache 丢翻译 | 中 | hash 缓存重应用、不重调 LLM |
| LLM 偶发非 JSON 输出 | 低 | 去 fence 重试→逐条降级→跳过记日志，绝不写坏源文件 |
| Windows 兼容（uninstall.ps1） | 低 | 核心功能 bash+node 在 Windows CC 的 bash 可跑；ps1 还原作为已知后续项 |

## Open Questions

- 是否需要在首次后台翻译时给用户一个「正在翻译，下次启动生效」的提示？（当前方案静默后台，可后续加 Notification）
- GLM key 是否要支持写入 settings.json 而非仅环境变量？（当前仅环境变量，更简单）
- 项目级 skill（`$cwd/.claude/`）默认关是否合理？（避免污染他人项目，默认关，可配置开）
