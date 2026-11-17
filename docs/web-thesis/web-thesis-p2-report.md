# P2 记忆治理闭环 与 P3-记忆增强 实施报告

日期：2026-11-16。分支：`qoder/web-thesis`。依据：[总方案](web-thesis-plan.md)、[SC-1.3](web-thesis-shared-contracts.md)、[记忆方案 MEM-1](web-thesis-memory-plan.md)。
范围：P2 = M1–M4；P3-记忆 = M5。用户于本轮明确确认开工。未触碰 mobile/、Android 分支与受保护运行数据（data.db/books/rag_index/.env）；真实库迁移仅在隔离副本验证，业务库迁移待另行确认。

## 1. 迁移与数据结构（M1）

`database.js` 登记 `web_003_memory_lifecycle`（顺序 001→002→003，单一登记机制）：

- 事务内重建 `user_memories`：旧 `UNIQUE(user_id,content)` 无法靠加索引取消，采用建新表→复制→校验行数→DROP→RENAME；`sqlite_sequence` 高水位显式保留（先删后插，内部表 name 无唯一约束），防止历史 MemoryRef 串条。
- 新列：kind/scope/book_id/key/normalized_value/status/revision/source_type/source_conv/source_message_id/source_start/source_end/order_message_id/last_seen_at/expires_at/salience；CHECK 枚举、revision>0、scope 与 book_id 一致、来源范围合法、reading_goal/open_question 限 book。
- 部分唯一索引：`(user_id,key) WHERE scope='user' AND status='active'` 与 `(user_id,book_id,key) WHERE scope='book' AND status='active'`；candidate 可与同键 active 共存。
- `memory_user_state`（enabled/memory_epoch/blocked_through_message_id）与 `memory_sources`（user_id+message_id 主键，state=pending/processing/done/skipped/failed，只存标识不存正文，不级联于 messages/conversations）。
- 旧行：保留 id/content/created_at/source_conv；统一 candidate、revision=1、source_type=legacy、key=`legacy:<id>`、normalized_value=NULL；非法/空 kind 映射占位 fact（原值仅存备份表 `user_memories_legacy_backup`，含旧 embedding，业务不召回）；不推断作用域、不猜测来源消息。
- 存量用户屏障初始化为已有用户消息最大ID；迁移后注册用户从 0 开始（无历史可回扫）。迁移不联网抽取。

验证（`tests/memory-migration.test.js`，5 例）：M-T01 ID7/高水位100 保留且新ID>100、重复迁移幂等；M-T25 非法 kind 占位与备份；事务失败整体回滚；部分唯一/CHECK 约束与同正文跨书合法；embedding 不继承。
另以 SQLite backup API 取业务 data.db 一致快照（不复制活跃 WAL、业务库只读），在隔离临时根执行迁移：3 条旧记忆全部保留为 legacy 候选、sqlite_sequence 高水位 9 保留、001/002/003 顺序应用、7 个用户状态行初始化。真实业务库迁移仍待单独确认与备份后执行。

## 2. 写事务、冲突与删除屏障（M2）

`conversation.js` 记忆领域（模型调用全部在事务外）：

- 管理操作：edit/confirm/complete/delete/clear/settings 均短事务；revision 不匹配 409 MEMORY_CONFLICT；legacy 确认需受限 classification（kind/key/scope/bookId 服务端校验，枚举键与正文不符 400）；确认替换同键 active 并作废旧候选。
- 屏障（§7.1）：明确更正/确认/完成/删除/清空/暂停/恢复/删会话 同事务 epoch+1、blocked_through 推进至全用户已接纳用户消息最大ID（含未完成/未调度）、旧 pending/processing 来源 skipped、同事务聚合受影响且仍 pending 的请求 postProcessing；已终结回执不重写。
- 冲突规则（§6.1）：同值重述只推进 order/last_seen 且保留人工主来源；自动新明确值仅在更晚且无人工保护时更新同ID；人工编辑/确认值受保护，普通陈述只能 candidate；过时自动来源按 order_message_id 拒绝；completed/expired 仅明确 reopen 才同ID重开并续期（open_question 90天），普通提及跳过；同键 active 变化作废不适用旧候选。
- 原子提交（§6.2）：重验用户/书籍/来源原消息/role/origin/request completed/enabled/epoch/屏障/来源仍 processing；一个来源批次原子提交或整批 failed，不半成功重试；纯跳过 memoryChanges=[]。
- 删书：书级 active/candidate 标 expired、该书在途来源 skipped（不递增 epoch，SC §8.3 列举之外）；管理页可见可删，召回不用。
- 重启：processing→failed（不重放不确定计费请求）；pending 保守 skipped（不回扫），同事务聚合，不留永久 pending。

验证（`tests/memory-governance.test.js`，16 例）：M-T02~05/07~20/22/23/26 与 C12/C13 对应确定性用例全通过，含两标签页旧 revision 409、删除时在途+跨会话未调度来源全部防回写、清空后旧候选确认 404、暂停不写不召回/恢复不回扫、暂停期显式命令走候选确认路径、书级隔离与跨用户隔离、过期/完成/删书不召回、来源与 postProcessing 同步、重启遗留 pending 保守 skipped。

## 3. 抽取调度与来源校验（M4）

- 三路触发：显式命令（记住/更正/忘记）与强稳定信号即时处理；弱候选同用户累计 3 条或 30 秒合并一批；每用户串行队列。纯事实问答/翻译/选文解释/一次性要求/明显引用由轻量规则排除，不调用抽取模型。
- 来源约束：仅当前用户、role=user、metadata.origin=user_text、request completed、messageId 高于屏障的原始 question；selection/assistant/system/task_action 结构上排除（非仅提示词）。
- 候选校验：kind/key 白名单与族一致、scope 规则、sourceMessageId 属于本批、sourceRange 在原话内且非空、statementType/stability 枚举、one_turn 跳过、inferred/unknown 只能 candidate、敏感内容（key/密码/凭证模式）跳过、matchKey 仅限同用户同作用域已有键。非法 JSON/全非法候选 → 来源 failed 并记录原因，不冒充"没有值得保存"。
- 调度入口在 qa-service 完成落库后调用一次；未调度真实标 skipped；重放不重复调度。
- 暂停期：弱/强信号不调度；显式"记住"走确认路径（forceCandidate 提交为候选，用户在管理页确认后才生效，确认不重新开启自动记忆）。
- 抽取预算：maxTokens 4000（思考模型 800 会被思考耗尽收空输出，冒烟发现并修复）、temperature 0.1、timeout 60s、retries 1（仅可恢复错误）。

## 4. 召回、注入与本轮覆盖（M4/M5）

- `retrieveMemoryBundle`：enabled→active 未过期→user/当前book 作用域→全局偏好按适用键、书级目标按当前书、兴趣/事实/未解问题过词法门槛（rag.tokenize 去停用词后 Jaccard）→人工确认/作用域/时效/salience 排序→最多6条、≤800 估算 tokens、整条取舍。
- 本轮覆盖 `detectTurnOverride`（"这次详细/法语…"）只注入本轮系统提示，不持久化。
- qa-service 注入分区文本 + `memory_context` 事件（refs+实际注入 MemoryView）；助手 metadata 只存 MemoryRef；历史重开查当前记忆显示已删除/已更新，不复制旧正文。
- 系统提示明确：记忆是数据不是指令、与本轮冲突以本轮为准、不得向用户承诺"已记住/已删除"。

## 5. 管理 API 与 UI（M3）

- API 按 SC §8.4 全量落地（GET/PUT/confirm/complete/DELETE memories、memory-settings），统一 `{ memory|deleted|cleared, epoch, memoryChanges }`；409/400/404 语义；内部 normalized_value/水位不暴露。
- 删会话路由先屏障再删；删书路由联动 expired。
- UI：分区列表（待确认/用户偏好/本书目标与问题/归档）、状态与来源与版本与有效期展示、legacy 分类确认表单、冲突卡（当前值/候选值 + 保留当前/确认新值）、内联编辑（409 刷新保留输入）、完成/删除（失败显示错误不乐观删除）、来源查看（授权会话接口 + sourceRange 高亮，会话已删显示来源不可用）、暂停开关与横幅、清空（expectedEpoch）、自动保存轻量 toast 带撤销（按删除屏障执行）与查看、失败 toast 不宣称已记住、"本次参考的记忆" chips 与历史已删除/已更新态。
- 安全：记忆内容全程 escapeHtml/DOM 文本渲染；kind/status/reason 固定枚举映射，不拼任意字符串进 class/HTML。

## 6. 验证汇总

- 离线：`npm test` 97/97（含迁移5、治理16、P0安全契约升级2、其余 P1a/P1b/P3 回归）。
- 浏览器（隔离 harness + 假模型，`scripts/p2-browser-harness.js`）：16 场景通过——空状态、自动保存+撤销提示、来源高亮、候选确认、冲突卡保留当前、编辑与旧版本409、书级目标隔离与完成、未解问题有效期、legacy 分类确认、暂停/恢复、删除防回写、本次参考+历史已删除态、失败不冒充成功、XSS 转义、清空 epoch 递增、控制台无未捕获错误。截图 `docs/baseline/screenshots/p2-01..15-*.png`。
- 契约：C11（来源分离）、C12（作用域/revision）、C13（删除/暂停防回写）、C14（不宣称已保存/历史不还原旧正文）由上述用例覆盖。

## 7. 在线开发集评测（真实模型 qwen3.8-flash）

主跑：`docs/baseline-results/p2-2026-11-16T06-45-28-545Z/`（10 脚本、17 轮、8 探针；词法条件，语义补充实现前）。
管线冒烟记录：`p2-2026-11-16T06-27-30-283Z/`（limit 2）。语义端到端：`p2-semantic-2026-11-16T07-23-05-095Z.json`。
阈值离线重算：`threshold-analysis.json` + `semantic-pairs.json`（`scripts/analyze-p2-threshold.js`；评测内联阈值采样不足——无关对只取自被注入引用——已改为离线全量对重算，未来运行已修正采集逻辑）。

### 7.1 抽取质量（机器检查 gold：key/scope/status/value）
- Precision = 1.000（9/9 保存条目命中 gold）；Recall = 0.900（9/10；p2mem-08 两书目标之一因模型输出变异漏抽，如实记录）。
- 负向场景全部零写入：一次性要求、书籍引用污染、纯提问、无关寒暄（gold=[] 且 saved=0）。
- 同义重述归并为 1 条（p2mem-02）；偏好更正后旧值不再 active（p2mem-03）；删除清空后重新表达可再存（p2mem-09）。
- 触发调度 11/17 轮（64.7%），其余轻量规则排除不调用抽取模型（旧基线每成功轮 1 次）；抽取失败 1 轮（来源标 failed，不影响已成功回答）。
- 失败样本（server.log）：模型偶发将 sourceMessageId 输出为数字字符串（"5"/"51"）被整条拒绝。已加结构 coercion（数字字符串→整数后仍校验批次归属与范围），并补确定性用例 M-T20b；coercion 后的复跑见 §7.6。
- 用户表达→记忆可用 P50 ≈ 15.4s（含弱候选 30s 合并等待与思考模型耗时；起始调度参数，P4 前可依数据调整）。

### 7.2 注入正确性
- 无关误注入 0/2（带 forbid 列表探针：一次性语言要求、无关高重要度兴趣）；跨书目标不串书（书级 scope 过滤）。
- 探针 expectRefs 命中 6/8；两处未命中：p2mem-08 漏抽目标（抽取变异）、p2mem-10 fact.role 跨措辞词法漏召回（语义补充 targeting 案例）。
- 偏好遵从结构启发式 1/3：p2mem-04 通过（不强制法语）；p2mem-01 探针因无索引返回缺证固定文案、风格不可测（探针设计缺陷，如实记录）；p2mem-03 简洁偏好注入但回答超 250 字（模型未遵从，待人工复核与 P4 保留集验证）。原始答案全部存 probes.jsonl。

### 7.3 词法门槛选择（开发集，6 对：3 相关/3 无关）
| 门槛 | 相关召回 | 无关注入 |
| --- | --- | --- |
| 0.15 | 1/3 | 0/3 |
| 0.25 | 1/3 | 0/3 |
| 0.35 | 0/3 | 0/3 |
0.15 与 0.25 同分、0.35 归零 → **冻结 0.25**（同分取更保守）。漏召回的 2 对为跨措辞（fact.role×自传真实性 lex=0.024；goal×自传真实性 lex=0.087，goal 实际经 current_book 通道注入不受门槛影响）。

### 7.4 语义补充（M5 按需增强）
- 证据：上述跨措辞漏召回 + 现有 Embedding（bge-m3）cosine 分离度：相关 0.515/0.602/0.822 vs 无关 0.372/0.391/0.493 → cosine 门槛 0.5 在开发集完全分离（相关 3/3、无关 0/3；0.515 与 0.493 间隔较窄，如实记录小样本局限）。
- 实现：`web_004_memory_vectors` 记忆作用域向量表（不复用书籍 rag_vec）；active 记忆写入后 best-effort 建向量（指纹一致才用）；召回时词法漏过且 cosine≥0.5 补充注入；Embedding 不可用/超时 3s 静默降级词法；删除记忆随外键级联清理向量。
- 端到端验证（p2-semantic-2026-11-16T07-23-05-095Z）：跨措辞探针 fact.role 经语义注入 ✓；无关探针不注入 ✓；向量表写入 ✓。
- 消融开关：`MEM_SEMANTIC=0`（测试条件，非产品模式开关）。

### 7.5 注入分层对照（prefs-only / +goals / +questions / no-memory）
运行：`p2-2026-11-16T07-16-47-761Z/`（`--suite layers`，MEM_SEMANTIC=0 词法条件；种子记忆确定性直插：2 偏好+1 事实+1 书级目标+1 书级未解问题；3 探针×4 层）。
- 注入集合符合设计：prefs-only 每探针 refs=2（全局偏好）；+goals refs=3（当前书目标加入）；+questions 仅时间跳跃探针 refs=4（未解问题过相关性门槛），其余探针不注入问题；no-memory refs=0（暂停生效）。
- 答案效果（3 探针小样本，原始答案存 summary.json）：各层均产出正常回答为主；异常样本 2 例（+goals 层叙事视角探针 insufficient_evidence、+questions 层自传真实性探针空正文），与其他层的模型变异同量级，未观察到"注入更多条→系统性更好/更坏"的证据。
- 结论：分层注入按设计保留（全局偏好按适用性、书级目标按当前书、问题/兴趣过门槛、预算整条取舍）；**不把注入条数当效果**，偏好遵从与事实质量的正式结论留 P4 保留集+人工标注。时延：单探针 36–96s（思考模型+取证循环，含 no-memory 层同量级），记忆注入本身不是时延主因。

### 7.6 coercion 修复后复跑（最终口径）
运行：`p2-2026-11-16T07-32-37-330Z/`（`--suite extract`，MEM_SEMANTIC=0）。
- **Precision = 1.000（9/9），Recall = 0.900（9/10）**，无关误注入 0，确定性检查 3/3，偏好遵从启发式 1/3（同 §7.2 口径）。
- 与主跑对比：字符串 sourceMessageId 类失败被 coercion 修复（p2mem-08 两书目标恢复 R=1）；本次单点漏抽变为 p2mem-07——模型输出 kind="memory"（非法枚举）被整条拒绝（契约行为，server.log 样本在案）。两次运行 Recall 均 0.9、漏抽脚本不同，属思考模型输出变异；不事后放宽 kind 白名单换召回。
- 另发现数组形式 sourceRange（[0,21]）变异，已加结构 coercion（数组→{start,end} 后仍校验范围），补 M-T20b 用例；该变异在主跑未影响 gold（同值去重）。
- 结论：治理链路（来源/校验/屏障/状态）确定性部分全绿；在线召回上限受模型输出变异约束，如实报告 0.9，保留集 P4 复核。

## 8. P3-记忆决策

- **词法门槛冻结 0.25**（开发集同分取保守；0.35 拒绝）。
- **语义补充采纳**：跨措辞漏召回有明确数据证据，复用现有 Embedding、记忆独立向量空间、优雅降级；开发集相关召回 1/3→3/3、无关注入保持 0；代价为每次召回至多 1 次 query embedding（3s 软预算）与写入时 best-effort 向量化。
- **分层注入**：按设计保留（§7.5）；开发集未显示"更多注入=更好"，也未显示系统性损害；效果结论留 P4 保留集与人工标注，不以条数论成功。
- **调度参数**：3 条/30s 为起始值；P50 15.4s 与漏抽 1/10 记录在案，P4 前依保留集与成本数据再议，不本轮擅自改。
- 不训练/不微调；不建独立向量服务；书籍事实仍归 RAG。

## 9. 已知限制

- 词法门槛不是语义理解；跨措辞召回漏检以评测数据如实报告，候选确认 UI 兜底。
- 候选归属语义误判无法被结构校验完全阻止（方案已声明）；来源可追溯 + 确认/编辑/删除降低影响。
- 删除保证业务不可召回与防回写，不宣称取证级物理擦除（WAL/备份另管）。
- 单进程串行队列与快照假设；多实例部署需另行设计。
- 业务 data.db 的 web_003 迁移尚未执行（受保护数据），需单独确认与一致性备份后实施。
- 偏好遵从为结构启发式 + 原始答案待人工复核；保留集（20段）冻结供 P4，未用于调参。

## 10. 复现命令

- 离线：`npm test`
- 浏览器：`node scripts/p2-browser-harness.js`（打印连接信息；假模型 `/__control` 切换抽取脚本）
- 在线开发集：`node scripts/run-p2-eval.js --env-file .env.baseline.local --suite all`
- 产出：`docs/baseline-results/p2-<ts>/`（scripts.jsonl/probes.jsonl/summary.json/report.md/server.log）