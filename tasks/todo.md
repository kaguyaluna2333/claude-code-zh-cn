# TODO：Skill / 插件 `/` 命令说明自动汉化

> 详细计划见 `tasks/plan.md`。每个任务 acceptance criteria / verification / 依赖 / 文件清单都在 plan.md。
> 原则：垂直切片，每个 task 交付一条可独立验证的路径；自底向上（先 foundation）。

## Phase 1 — 最小端到端 happy path

- [x] **T1** frontmatter 解析/写回（plain + 双引号/单引号/`>`/`|` 块）+ CJK 检测 + 单测
  - `plugin/skill-i18n/lib/frontmatter.js`、`lib/cjk.js`、`tests/skill-i18n-frontmatter.test.js`、`tests/skill-i18n-cjk.test.js`
  - 验证：`node --test` 19/19 全绿（block scalar 提前在 T1 实现）
- [x] **T2** scan + translate(claude) + apply + bash 入口 + cache.js，打通单 skill
  - `plugin/skill-i18n/{scan,translate,apply}.js`、`translate-skills.sh`、`lib/cache.js`（提前建）
  - 验证：测试树端到端跑通，skill/command 中文化、正文无损、幂等、缓存命中重应用

### ✅ Checkpoint 1（人工 review 后进入 Phase 2）
- [x] 单 skill/command 端到端跑通，重跑识别为已译（0 待翻译）
- [x] 缓存命中：模拟插件覆盖后不调 LLM、重应用缓存译文
- [x] 所有新 `.js` `node --check` 通过，19 个单测通过
- [x] **人工 review**：五轴 review 出 27 条（0 Critical/2 Important/15 Suggestion/10 Nit），已修推荐批次（CRLF/key-env/\r/兜底/chmod/写前自检/单次parse/测试加固）+ provider 改协议分类（claude/openai/anthropic）。20/20 测试 + CRLF 端到端通过。

## Phase 2 — frontmatter 健壮性 + 缓存

- [x] **T3** frontmatter 扩展（单引号 / `>` 折叠 / `|` 字面块）+ 写前自检
  - block scalar 在 T1 提前实现；写前自检 verifyRewriteSafe 在 review 批次补
  - 验证：真实 ponytail-audit 8 行 `>` 块端到端往返无损（保留命令名/术语）
- [x] **T4** 全局译文缓存 + 增量逻辑 + 单测
  - cache.js 在 T2 提前建；tests/skill-i18n-cache.test.js 6 个单测
  - 验证：模拟插件覆盖后缓存命中、不重调 LLM；${} 占位符端到端保留

### ✅ Checkpoint 2
- [x] 硬 case（ponytail `>` 块 / ${} 占位符）端到端通过；缓存命中不重调；27 个单测全绿

## Phase 3 — 全范围 + API provider

- [x] **T5** 扫描范围扩展（commands / plugins cache / 元数据）+ JSON 写回
  - 新增 lib/metadata.js；scan 扩展插件来源；apply 按 path 分组 md/JSON 分流
  - 验证：plugin.json + marketplace.json(顶层+plugins[]) 测试树端到端，JSON 合法
- [x] **T6** openai/anthropic provider 实现
  - translate.js 手写 https 零依赖；provider=claude/openai/anthropic；GLM 走 anthropic
  - 验证：mock server 9 测试（协议解析/请求头/路径/model/错误处理/缺 key 报错）

### ✅ Checkpoint 3
- [x] 真实 `~/.claude` 小批验证（31 文件）：frontmatter/元数据/正文无损，翻译质量好，符号链接源仓库 0 被改（默认不跟随）
- [x] restore --all 全量还原验证通过（含符号链接真实文件）
- [ ] 全量 577 条待用户决定（claude 慢/费额度，或配 GLM key）

## Phase 4 — 自动触发 + 可逆 + 边界

- [x] **T7** session-start hook 集成（后台异步 + 超时 + 禁用开关）
  - `plugin/hooks/session-start`（第 717 行后插入 ~11 行）；session-start-hook.test.js 加 DISABLE 兼容
  - 验证：`bash -n` OK；19/19 测试通过（加 DISABLE 跳过后台，避免测试触发真实翻译）
- [x] **T8** restore.js + uninstall.sh 集成
  - 新建 `plugin/skill-i18n/restore.js`；`uninstall.sh` rm -rf 前插入还原调用
  - 验证：汉化树（skill+元数据）还原后回英文无残留；`bash -n uninstall.sh` OK
- [x] **T9** 边界收尾（符号链接跟随/跳过、占位符校验、幂等）
  - scan 加 FOLLOW_SYMLINKS（默认跟随写真实文件）；translate 加 ${} 占位符校验
  - 验证：符号链接跟随写真实文件 / FOLLOW_SYMLINKS=0 跳过；占位符校验单测；幂等（标记+缓存）

### ✅ Checkpoint 4
- [x] restore 端到端还原；符号链接跟随/跳过；占位符校验；session-start-hook 兼容
- [ ] 真实「重启 CC 自动汉化」待用户环境验证（hook 逻辑已验证，后台 & 不阻塞）

## Phase 5 — 工程化 + 发布

- [x] **T10** preflight 集成（bash -n + node --check）
  - `scripts/preflight.sh` 加 translate-skills.sh + 8 个 .js 检查
  - 验证：bash -n + node --check 全过（45 测试全绿）
- [x] **T11** 文档
  - `plugin/skill-i18n/README.md`（详细：原理/环境变量表/可逆性/权衡/限制）+ README.md 章节
- [x] **T12** 版本发布准备
  - manifest 2.4.61→2.5.0 + CHANGELOG 顶部 2.5.0 段
  - 额外加固：translate 批次失败降级逐条翻译（review #5 完整方案）
  - tag / release 待用户确认

### ✅ Checkpoint 5（可发布）
- [ ] preflight --release-state 全绿（待发布环境，含联网 sentinels 检查）
- [ ] 端到端：真实全量验证进行中（后台 claude 翻译 577 条）
- [ ] 人工 review 后打 tag 发 Release
