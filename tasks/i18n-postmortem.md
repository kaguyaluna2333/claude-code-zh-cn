# Skill/Command/Builtin 汉化复盘

> 把汉化范围从「cli.js UI 文字」扩展到「skill / command / builtin 命令描述」时踩的坑，及其对项目的改进建议。
> 每条都带：现象 → 根因 → 当时走的弯路 → 正确做法 → 落到哪个文件的可执行改进。

## 总览：四个层面的缺口

| 层面 | 核心问题 | 影响 |
|---|---|---|
| 扫描（collect.js） | 目录结构认识不全，固定子目录枚举 | 反复漏网，多轮才覆盖全 |
| patch（patch-cli.js） | 只扫 `"..."` 字面量，漏转义引号/模板字面量/data 段 | builtin 命令描述汉化失败 |
| 验证 | `strings` 假阴性、`--help` 假阳性 | 多次误判 patch 成败 |
| 环境 | CC 自动更新、未验证窗口 patch 不持久 | patch 反复失效 |

---

## 一、扫描层面（collect.js）

### 歪路：每发现一类目录结构就扩展一次

最初 `collectPluginMarkdown` 只扫 `p/skills` 和 `p/commands`。实际插件目录结构极其多样，**逐轮发现**：

1. `.agents/skills`、`.cursor/skills`（ECC 等把 skill 放这里）→ deep-research 等"没汉化"
2. `.openclaw/skills`（ponytail 的副本）
3. `commands/` 下的符号链接（addy-*.md）—— `isFile()` 对符号链接返回 false，被跳过
4. `plugins/marketplaces/` 整个目录漏扫（只扫了 `plugins/cache/`）→ claude-hud 全系列"没汉化"
5. marketplaces 下的多 plugins 层：`marketplaces/<name>/plugins/<plugin>/commands/`（claude-plugins-official）→ hookify 等

**根因**：用「固定子目录枚举」应对「不固定的目录结构」。每次都是一个用户报告 → 定位 → 扩展一条路径 → 再报告。

**正确做法**：递归遍历 + 排除规则。`collectMarketplaces` 最终改成了递归 + `excludeSegs`（.git/node_modules/docs/dist/tests/src 等），一次覆盖所有结构。

**改进建议（P0）**：
- `collectPluginMarkdown`（cache 目录）也统一为递归 + 排除规则，和 `collectMarketplaces` 用同一套逻辑（目前 cache 还是固定子目录枚举 + `skillSubs` 数组，新增结构仍要改代码）
- 抽公共 `walkAndCollect(root, {excludeSegs})`，cache/marketplaces/user 三处共用
- commands 的符号链接判断：`isFile()` 改为 `isFile() || (followSymlinks && isSymbolicLink())`（collectUserCommands 已修，collectPluginMarkdown 的 commands 分支也该统一）

---

## 二、patch 层面（patch-cli.js + binary）

### 歪路：把"翻译失败"误归因于"扫描器不认模板字面量"

builtin 命令（`/cd`、`/terminal-setup`、`deep-research`、`/design-sync`、`/design-login` 等）的描述 patch 失败后，我曾断言"patch-cli.js 只扫 `\"...\"` 字面量，漏模板字面量和转义引号"。**这是错的**——对抗审查读源码推翻了它：

| 字符串所在位置 | patch-cli.js 实际能力 | 复盘原断言 |
|---|---|---|
| 普通 `"..."` 字面量 | ✅ 能（行370 `state="double"`） | ✅ 一致 |
| 模板字面量 `` `...` ``（含 `${}` 嵌套） | ✅ **能**（行243/253 `state="template"` + templateStack + `replaceWholeTemplateLiteral`/`replaceTemplateLiteralTextParts`） | ❌ 原断言"漏"，错 |
| `"description:\"...\""`（字符串值里再嵌一层转义引号，序列化对象） | ❌ 不能（scanStringLiterals 把外层 `"..."` 当一个字面量，内层 `\"` 是其内容，不再解一层） | ✅ 一致 |
| bun data 段（不可文本寻址） | ❌ 不能（需 bun-binary-io 提取/回写） | ✅ 一致 |

**真正的根因是两条，被我混成了一条**：
- **(A) JS 文本段字符串** — scanStringLiterals 已覆盖（含模板字面量）。**无需改 patch-cli.js**。
- **(B) 转义引号内嵌 + data 段** — 这才是 builtin 命令描述扫不到的真因。需要「等长 Buffer 替换」补刀。

**当时走的弯路**：基于"翻译失败"现象反推根因，没读 patch-cli.js 源码验证 → 把 (B) 的锅扣到 (A) 上 → 差点去"扩展 scanStringLiterals 支持模板字面量"（已经支持，重复造轮子）。

**正确归因 + 做法**：
- 模板字面量里的 bundled skill（design-sync）其实 patch-cli.js 能扫——需实测确认当时为何没译，可能是该串在 data 段而非 JS 文本段
- 真正需要等长替换的是 (B)：data 段序列化字符串 + 转义引号内嵌

**改进建议（修正后）**：
- **P0 集成等长替换器** `plugin/patch-builtin.js`：专门处理 (B) 类（data 段 + 转义引号内嵌），读 cli-translations.json 对应条目做等长 Buffer 替换，保留 `${}` 占位符。**不要去改 patch-cli.js 的 scanStringLiterals**（已完备）
- 实施前**先 grep 验证**：每条 builtin 描述到底在 JS 文本段（patch-cli.js 能处理）还是 data 段（要等长替换），别一刀切

---

## 三、验证层面

### 歪路：验证方法不可靠，多次误判

| 验证方法 | 结果 | 真相 |
|---|---|---|
| `strings binary \| grep 中文` | 0 命中 → 判定"没 patch" | **假阴性**：bun 把 JS 段压缩，strings 搜不到，但 patch 其实成功了 |
| `binary --help` 输出中文 | 判定"patch 成功" | **假阳性**：`--help` 中文是 CC 运行时生成的，不是 binary 文本段 |
| `grep -ac 中文 binary` | 正确命中 | 可靠 |

**根因**：不了解 bun binary 的 JS 段是压缩存储的。

**正确做法**：用 `grep -a`（强制二进制当文本搜）验证；或功能验证（实际跑命令看输出）。

**改进建议（P1）**：
- 项目文档（plugin/skill-i18n/README.md 或 docs）明确：**用 `grep -a` 验证 binary，不要用 `strings`**
- patch 工具自带验证：patch 完成后 `grep -ac` 一条已知翻译，输出命中数

---

## 四、环境层面

### 歪路：CC 自动更新反复破坏 patch（真坑）；provisional 不保留 patch（记错了）

**真坑 — CC 自动更新**：CC 从 2.1.191 自动更新到 2.1.195，新 binary 没被 patch，所有汉化"失效"。用户以为是翻译问题，实际是 binary 换了。花了多轮才意识到"汉化失效"=「CC 升级了」。

**记错的地方 — install.sh provisional**：我曾断言"install.sh 对未验证版本走 provisional 分支，自验证后恢复原版、不写标记"。**对抗审查读源码推翻**：install.sh 行1257-1264，provisional 自检通过后**保留 patch**（不调 cp 恢复），行1284-1285 写 MARKER_FILE（`.patched-version`，带 `|provisional|` 标记）。即"持久化 + 标 provisional"**早已实现**。我当时基于"重启后英文"现象误判了 install.sh，实际根因是 CC 自动更新下载了全新 binary（连 .patched-version 都还是旧的，对不上新 binary）。

**文件名张冠李戴**：native 安装的标记文件是 `.patched-version`（install.sh 行19）；`.patched-target` 是 **remote/npm 安装路径**（install-remote.sh）的文件。我多处写混了。

**改进建议**：
- **P0 install.sh 前置处理 CC 自动更新**：检测 `DISABLE_AUTOUPDATER` 未设置时明确警告 + 一键禁用选项（这条仍成立——自动更新才是 patch 反复失效的主因）
- ~~P1 install.sh provisional 持久化~~ → **已实现，删除该建议**。真正的缺口在 session-start hook：它是否识别 `.patched-version` 里的 `provisional` 标记、并在 CC 升级后正确重 patch 新 binary？这需读 hooks/session-start 确认（复盘未做这步）

---

## 五、CC 机制认知（文档缺口）

### 歪路：不理解 CC 怎么加载 skill/command，反复在错误层面修

踩坑后才搞清的 CC 机制（应写进项目文档，避免下次重踩）：

1. **CC 不跟随符号链接 skill**：`readdirSync(withFileTypes)` + `isDirectory()`，符号链接目录返回 false → CC 跳过。所以符号链接 skill 即使翻译了文件，CC 也不加载。修复要么改真实目录，要么 CC 端解决。
2. **CC builtin 命令描述在 binary 里**（不是 plugin、不是 SKILL.md）：`/cd`、`deep-research`、`/design-sync` 等是 CC 自带的，描述硬编码在 cli.js/binary。`deep-research` 曾被误当成 plugin skill，翻译了 `.agents/skills/deep-research/SKILL.md`（错误副本），实际 CC 显示的是 binary 里的 builtin 描述。
3. **CC bundled skill**（design-sync）：整份 SKILL.md 作为模板字面量存在 binary 里，运行时解压到 `/tmp/claude-501/bundled-skills/`。要汉化得 patch binary 源文本。
4. **CC `/` 菜单数据源**：进程启动时扫描 SKILL.md 的 `description:` 字段构建内存索引（不落盘、不随文件实时刷新）→ 改文件后必须**完全重启进程**（不是 `/clear`）。
5. **bun binary 结构**：JS 段压缩存储（strings 搜不到，grep -a 能搜）；data 段含序列化命令定义（部分不可文本寻址）。

**改进建议（P2）**：新增 `docs/cc-loading-mechanism.md`，记录上述机制，指导 scan/patch/验证策略。

---

## 六、范围与引擎

### 歪路：范围混淆 + rate limit

- **agents 范围**：一度想把 `~/.claude/agents/*.md` 也翻译，用户明确「只要 skill/command 说明，不要 agents 和正文」。→ 应做成配置开关（`ZH_CN_SKILL_I18N_INCLUDE_AGENTS`）。
- **翻译引擎 rate limit**：大批量（577 条）触发 claude CLI 限流，整批失败。已加「小批次重试」降级，但失败的 5 条要手动补。

**改进建议（P2）**：
- collect 加 `--include-agents` 开关（默认关）
- translate.js 的降级小批次已有，但应加「连续失败 N 次提前终止 + 报告未译清单」，避免无限重试

---

## 改进优先级清单

### P0（架构性，必须做）
1. **collect 统一递归扫描**：cache/marketplaces/user 三处共用 `walkAndCollect(root, {excludeSegs})`，告别固定子目录枚举。**注意**：collectMarketplaces 曾有 `if (e.name === "commands" || e.name === "commands")` 重复条件 bug + commands 特例后未 continue 导致深层漏扫——已修（collectCommandsDeep 递归 + continue），抽公共函数时别把缺陷带进去
2. **集成等长替换器** `plugin/patch-builtin.js`：**只针对 data 段 + 转义引号内嵌**（patch-cli.js 真盲区），保留 `${}` 占位符。**不要动 patch-cli.js 的 scanStringLiterals**（模板字面量已支持）
3. **install.sh 前置处理 CC 自动更新**：检测 + 警告 + 一键禁用（patch 反复失效的主因）

### P1（流程，应该做）
4. **验证 session-start hook 对 provisional 标记的语义处理**：install.sh 持久化已落地，但 hook 侧是否识别 `|provisional|`、CC 升级后是否正确重 patch 新 binary，需读 hooks/session-start 确认
5. **验证方法标准化**：文档明确 `grep -a`（不用 strings），patch 工具自带 `grep -ac` 验证
6. **commands 符号链接统一**：所有 collect 的 commands 分支用 `isFile() || (follow && isSymbolicLink())`（collectUserCommands 已修，collectPluginMarkdown 的 commands 分支待统一）

### P2（文档/配置，可以做）
7. **CC 加载机制文档** `docs/cc-loading-mechanism.md`
8. **agents 范围开关** `--include-agents`
9. **translate.js 连续失败终止 + 未译清单**
10. **同步 CLAUDE.md 计数**：根 CLAUDE.md 行9 已从 1887 更新为 1901（本次已修）

---

## 附：关键教训

1. **先搞清宿主（CC）的加载机制，再决定改哪里**——否则会在错误层面反复修（翻译文件但 CC 不读文件）。
2. **扫描用递归 + 排除，不用枚举**——目录结构永远比你想象的多。
3. **验证方法要可靠**——strings/--help 都会骗你，grep -a 不会。
4. **环境因素（自动更新）优先排查**——"突然失效"八成是环境变了，不是代码。
5. **临时脚本要沉淀**——/tmp 里的 patch-builtin.js 解决了问题但没进项目，下次还要重写。
6. **【复盘本身也适用】下结论前读源码，别从现象反推根因**——本次复盘把"翻译失败"误归因为"patch-cli.js 不认模板字面量""install.sh provisional 不保留 patch"，两处都是没读源码、从现象反推的错判，被对抗审查推翻。复盘和 debug 一样，断言要落到代码行号上验证。
