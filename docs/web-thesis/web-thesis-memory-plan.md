# 记忆实施方案：可信来源、更新治理与个性化应用

版本：MEM-1，2026-10-28。状态：P2（M1–M4）与 P3-记忆（M5）已于 2026-11-16 经用户确认实施完成；实施结果与偏差见 [P2报告](web-thesis-p2-report.md)。原设计保留如下供追溯。

前置阅读：[总方案](web-thesis-plan.md)、[共享约定](web-thesis-shared-contracts.md)、[P0方案](web-thesis-p0-plan.md)。本方案覆盖P2和P3-记忆。P1a先提供统一问答与原始消息接口；产品集成按既定P1b→P2顺序，不能借本方案提前重写公共链路。

## 1. 目标与不做事项

### P2必须完成

- 只从用户本人表达中保存有来源的信息，区分自动接受与候选确认。
- 用户级偏好与书级阅读目标分开，支持同义去重、明确纠错、编辑、确认、完成、删除和暂停。
- 控制抽取频率，不再每个成功回答都把末六条对话重新交给模型。
- 旧后台任务、未调度旧消息、旧标签页操作不能覆盖用户的新决定或复活已删除记忆。
- 提供真实的“处理中/已保存/待确认/失败”状态，不把LLM说“记住了”当实际成功。

### P3-记忆增强

优化相关性阈值、上下文预算、个性化解释效果，按实验决定是否增加语义召回。模型不训练、不微调；“更懂用户”由跨会话行为与纠错效果证明。

不做无限记忆库、用户心理/健康画像、跨书知识检索、自主推断永久能力等级、独立向量服务。书籍事实始终属于RAG，不写用户画像。

## 2. 前置接口与修改边界

P1a必须提供：服务端userId/bookId、稳定requestId、用户messageId、原始question单独保存、selection独立metadata、已完成请求状态、唯一后处理调用点、统一SSE和消息metadata。

原始user消息里已经拼进去的书籍正文不能安全逆解析；P2不对旧混合消息自动补抽取。历史会话仍保留，旧记忆经迁移后等待确认。

| 文件 | 本模块职责 |
| --- | --- |
| conversation.js | 记忆领域读写、来源判断、抽取调度、冲突事务、召回和作用域；复用会话访问方法 |
| database.js | 集成负责人实施记忆表迁移、状态/来源表与唯一约束 |
| server.js | 管理API、显式记忆命令接入、后处理结果查询、源会话删除屏障；不另写一套冲突规则 |
| public/app.js、index.html、styles.css | 记忆列表、候选确认、更正/完成/删除/暂停、来源展示和本次参考说明 |
| llm-client.js | 复用P1a的取消、超时、usage与错误契约，不自行fetch模型 |
| tests/、docs/ | 纯逻辑/事务/并发/UI测试、合成对话集、指标及报告 |

不改RAG的分块/排序，也不把记忆向量混写到书籍rag_vec表。若未来P3使用Embedding检索，必须在记忆自己的作用域内设计，不因同为1024维就混用不同语义空间。

## 3. 数据结构与迁移

### 3.1 迁移登记

登记 `web_003_memory_lifecycle`，依赖已确认的公共迁移机制与P1a消息metadata。迁移编号由一个集成负责人维护，与RAG的web_002不冲突。

现有user_memories的 `UNIQUE(user_id,content)` 不能保留：相同正文在不同书籍可能合法，SQLite原表约束也不能只靠新增索引取消。采用事务内重建表、复制旧行、校验后替换表的迁移方式；不删除数据库文件。

### 3.2 user_memories目标列

| 列 | 类型/用途 |
| --- | --- |
| id | INTEGER PRIMARY KEY AUTOINCREMENT，保留旧ID和原自增高水位 |
| user_id | 用户外键，删除用户才级联删除用户记忆 |
| kind | preference/fact/interest/reading_goal/open_question |
| scope、book_id | user时book_id=NULL；book时必须指定属于用户的书 |
| key | 服务端验证的规范键，用于同一作用域内的同类信息匹配 |
| content | 用户可读的当前记忆陈述，不直接采用模型任意格式 |
| normalized_value | 内部规范值，枚举偏好使用固定值，其他信息采用保守归一化；旧记录可NULL |
| status | candidate/active/superseded/expired/completed |
| revision | 正整数，从1开始，任何对外可见变更递增 |
| source_type | user_message/user_edit/user_confirmation/legacy |
| source_conv、source_message_id | 当前主来源，旧表source_conv沿用列名；读源内容时再次按用户鉴权 |
| source_start、source_end | 原始用户question内的UTF-16半开范围，可NULL；不是书籍Locator |
| order_message_id | 当前键最近处理的用户消息ID，用于跨会话来源先后判断 |
| created_at、updated_at、last_seen_at | 首次建立、最后修改、最近明确重述时间 |
| expires_at | 可NULL；过期后不再召回 |
| salience | 可保留旧列用于内部排序，不把模型给出的重要度当置信度或真值 |

source引用不级联删除记忆；源会话已删除时显示来源不可用，不伪造新来源。内部字段不额外暴露给前端；MemoryView遵守共享约定。

约束：

- CHECK枚举、revision>0、scope与book_id一致、来源范围合法。
- 用户级active唯一：`(user_id,key) WHERE scope='user' AND status='active'`。
- 书级active唯一：`(user_id,book_id,key) WHERE scope='book' AND status='active'`。不能用包含NULL的一个普通唯一索引代替这两个约束。
- candidate可暂时与同键active共存，用于展示冲突；同候选规范值在写事务中去重。
- completed只适用于reading_goal/open_question；新的明确未解需求可以按领域规则重开，不能因模型回答了一次就自动completed。

### 3.3 两张最小状态表

| 表 | 字段与作用 |
| --- | --- |
| memory_user_state | user_id主键、enabled、memory_epoch、blocked_through_message_id、updated_at；管理用户级暂停和删除屏障 |
| memory_sources | user_id、message_id组成主键；request_id、conversation_id、expected_epoch、state、error_code、created_at、updated_at；state=pending/processing/done/skipped/failed |

来源表只存标识和处理状态，不存正文；删除源消息后不级联删除其处理记录。后台任务提交时仍需验证原消息存在，来源处理记录不能代替原文证据。用户删除时可随用户级联清理。

messageId为全用户消息序列中的自增ID，用于判断先后；不能使用每个会话从1开始的seq，也不能以LLM完成时间代表用户表达时间。

### 3.4 旧记忆处理

1. 保留id、content、created_at和可用旧source_conv；保留sqlite_sequence原高水位，避免删除过的旧ID被重用导致历史MemoryRef串条。
2. 旧条目统一candidate、revision=1、source_type=legacy、key=`legacy:<id>`、normalized_value=NULL。scope=user只是待确认占位，不代表已推断出真实作用域。
3. 旧来源无法证明对应哪条用户原话，source_message_id/range保持NULL，不从最近消息猜测。
4. 合法旧kind保留；非法或空旧kind在新表映射为合法占位fact，以满足CHECK和MemoryView枚举。UI按source_type=legacy统一显示“待分类确认”，不把占位fact当已核实事实；原非法值仅保留在迁移备份中，不带回HTML。确认时核定真实分类与作用域。
5. 旧embedding不继承为新记忆语义索引；迁移前备份保留原值，新业务不依赖其未知模型/来源。
6. 初始化每用户blocked_through_message_id为已有用户消息最大ID，避免升级后自动回扫历史。
7. 迁移不自动联网抽取；旧记忆未确认不参与新回答。UI明确说明“历史记忆需确认”，不能无提示地改变用户体验。

用合成数据库验证迁移重复执行、失败回滚、条目数量、原文和ID不变。真实库操作需单独确认、一致性备份，不直接复制活跃WAL文件。回滚整库前必须停写并说明新数据处置；不自动丢弃迁移后的用户编辑。

## 4. 记忆键、值与作用域

### 4.1 首版键设计

| 信息 | 键示例 | 值与数量 |
| --- | --- | --- |
| 回答详细程度 | preference.answer_length | concise/balanced/detailed，用户级单值 |
| 回答结构 | preference.answer_format | 服务端支持的结构枚举，如bullets/paragraphs/steps，用户级单值 |
| 语言 | preference.language | 规范语言标识，用户级单值 |
| 例子偏好 | preference.example_style | 简短规范描述，单值；不自行推断职业背景 |
| 明确背景事实 | fact.role等受支持键 | 仅用户自述，不能把书中人物身份存入 |
| 主题兴趣 | interest.topic:<规范主题ID> | 每个主题一个键，多主题不互相覆盖 |
| 本书主要目标 | reading_goal.primary | 书级主目标；明确改变目标才替换，附加目标先确认 |
| 本书未解问题 | open_question:<服务端问题ID> | 可有多条；问题ID在同义归并时复用，不用整个正文当键 |

键是服务端认可的领域结构，不允许模型生成任意路径/SQL。枚举别名可确定性归一化；自由主题/问题只规范空白和约定的字符形式，不通过激进模糊匹配把两种概念强合并。

首次遇到开放主题/未解问题时，由模型提出规范主题或匹配关系，服务端在同用户同作用域内检索有限候选验证；模型可建议已有候选ID，但不能访问或修改范围外ID。

### 4.2 作用域规则

- 稳定表达/语言偏好默认user，跨会话与跨书适用。
- “读这本书为了…”、“本书这个概念还没懂”只属于当前book；缺少书籍上下文时先澄清，不随意归为永久画像。
- “这次讲详细点”是本轮要求，不持久化，却应在本轮模型上下文中优先于旧偏好。
- “我可能更喜欢图示”是候选，不据此覆盖active。
- “什么是隐喻？”只说明正在提问，不等于“用户长期不懂文学”；只有明确自述尚未理解且希望后续继续讨论，才能建立open_question。

## 5. 来源与抽取触发

### 5.1 可用来源

普通自动抽取只允许：当前用户、当前请求已completed、role=user、metadata.origin=user_text、尚未处理且messageId大于屏障的原始question。selection、书籍证据、assistant、system、会话摘要和task_action均排除。

模型候选必须指出来源messageId及sourceRange，范围对应原始question中的实际表达。结构上来源正确不等于语义上一定属于用户：问题内的引用、假设、转述也要识别；不确定时candidate，不能声称这套校验能完美阻止所有语义误判。

抽取输入不包含旧拼接正文或助手答案。为理解指代可提供最小用户上下文，但只有列入本次sourceMessageIds的新原话能产生写入，避免从上下文重复抽出旧偏好。

### 5.2 三条触发路径

| 路径 | 条件 | 行为 |
| --- | --- | --- |
| 显式命令 | 明确“记住/更正/忘记”并能定位用户自己的目标 | 接入统一记忆写服务；无歧义时及时执行，有歧义给确认卡；不靠LLM自行承诺成功 |
| 强稳定信号 | 用户本人稳定偏好/目标，范围清楚；已知键可确定性解析或需一次模型抽取 | 成功回答后立即处理新来源，不等待凑满批次 |
| 弱候选信号 | 可能含长期信息，但语义、稳定性或归属不明确 | 同用户累计最多3条或等待最多30秒后合并一次抽取；输出候选或跳过 |

纯事实问答、翻译、一次性要求与明显引用不调用抽取模型。轻量规则负责排除明显非记忆和识别明确命令，不用“出现喜欢二字”作为完整语义分类；不确定的少量表达才交给模型判断。

3条/30秒是起始调度参数，不是效果最优结论；P0/P2记录漏抽、可用延迟和调用量后调整。不同用户不混批；一个批次可含多会话，但每项必须独立绑定正确bookId与来源。可先按用户串行处理，避免并发同键写入。

### 5.3 抽取输出与校验

内部候选最小字段：kind、key或待匹配主题、normalizedValue、content、scope、bookId、sourceMessageId、sourceRange、statementType(explicit/inferred)、stability(stable/one_turn/unknown)、relation(equal/replace/independent/uncertain)。这些是待验证的建议，不是模型能直接执行的数据库命令。

服务端校验枚举、长度、范围、用户/书籍归属和来源处理状态；one_turn直接跳过，unknown/inferred不得自动active。禁止通过候选写入工具Key、密码或用户仅粘贴的凭证；疑似敏感内容不自动记忆，明确提示用户控制。

模型输出非法/超时：来源标failed并记录原因，不把空解析冒充“没有值得保存的信息”；不影响已经保存的正常问答。

## 6. 去重、冲突与写事务

### 6.1 处理规则

| 情况 | 处理 |
| --- | --- |
| active同scope+key且规范值相同 | 不新增；推进order_message_id/last_seen_at，保留人工主来源，不用自动重述覆盖user_edit/user_confirmation |
| completed/expired的目标或问题，用户明确“仍未解决/继续讨论” | 来源越过屏障、书仍有效且无更新active冲突时，同ID重开为active、revision+1、更新来源/顺序/有效期；普通提及不重开 |
| 同义措辞、关系明确等价 | active条目归并到同键同ID；非active先按确认/重开规则判断，不能仅凭向量接近判等价 |
| 同键自动来源的新明确值 | 新sourceMessageId更晚且没有人工确认保护时更新同ID、revision+1 |
| 明确“以后改为…”/UI更正 | 用户新决定优先，经验证后更新同ID与主来源、revision+1，并建立屏障 |
| 与已人工编辑/确认值冲突的普通陈述 | 生成candidate展示差异，不静默覆盖；明确纠错命令或用户确认后才能替代 |
| 新推断、模糊否定或关系不清 | candidate，不能删除/覆盖active |
| 不同book的相同键 | 各自保存，不互相替代 |
| 旧消息较晚完成抽取 | 不按完成时间覆盖更晚用户表达，按order_message_id拒绝过时建议 |

自由主题/问题的同义候选最多选同范围前8项交模型判关系；第一次匹配不可靠就保留候选确认，不引入全量向量去重服务。

同ID修改不保存一份永久旧正文版本表；历史MemoryRef通过revision显示“已更新”。superseded主要用于已被新决定淘汰的候选或非当前记录；删除时必须清理同一逻辑条目的残留内容，不让候选成为旧正文副本。

### 6.2 原子提交步骤

模型调用全部在事务外。拿到候选后，以短事务执行：

1. 重新验证用户/书籍、来源原消息仍存在、role/origin/request归属正确；自动路径请求必须completed。
2. 检查enabled、expectedEpoch、来源ID高于屏障、memory_sources仍为本次processing。
3. 读取同scope+key的当前条目、revision和最大order_message_id，拒绝过时自动来源。
4. 应用去重/候选/更新规则，依赖部分唯一索引兜底并发冲突。
5. 同键active改变时作废已不适用的旧候选，并递增其revision，防止旧标签页确认覆盖新值。
6. 同事务保存记忆变更、来源done/skipped和对应后处理结果。

事务失败不得只推进来源水位而丢失未写入的有效候选。一个来源产生多个候选，按本来源批次原子提交或完整标失败，不能一半成功后盲目全量重试。

普通后台写不递增用户epoch以免批次互相作废；manual edit/confirm/delete/complete/pause/resume与明确纠错会递增。每次记录自身revision仍递增。新来源如何优先由order_message_id和人工来源保护共同决定。

## 7. 删除、暂停与跨会话并发

### 7.1 用户级屏障

在同一个事务内处理明确删除/清空/更正/确认/完成/暂停/恢复：

1. 检查操作者、expectedRevision或expectedEpoch。
2. 将memory_epoch+1。
3. 将blocked_through_message_id推进至该用户所有会话当前已接纳用户消息的最大ID，包括尚未完成和未调度的消息。
4. 将这些旧来源的pending/processing标skipped；在途模型响应回来只能丢弃，不可换成新epoch重试。同事务重算受影响且尚pending的请求postProcessing，不能让请求查询永久显示处理中。
5. 执行目标操作并返回最新版本/epoch。

所有来源状态迁移（含重启将processing改failed）都须同步聚合对应请求：还有pending/processing则pending；全终结后有failed则failed，否则有done则completed，否则skipped。memoryChanges只列真实已提交条目的ID/版本；纯跳过来源返回[]，不虚构一个skipped记忆ID。已终结的旧操作回执不因后来删除记忆而重写成处理中。

这是保守而可证明的方案：删除一条记忆可能同时放弃其他尚未处理的旧来源；用户以后重新表达可重新保存。首版接受这一取舍，避免按语义建立复杂且可能漏拦的删除墓碑。

### 7.2 具体操作

- **单条删除**：删除该条正文、规范值、关联候选内容与可选向量，失效内存缓存；不保存正文墓碑。保护记录只留来源ID和状态。
- **清空**：删除该用户所有记忆/候选，不删除会话原话；推进整个用户屏障。
- **暂停**：enabled=false，停止新轮次召回与自动写入，仍可在管理页查看/编辑/删除。
- **恢复**：enabled=true且再次推进屏障，恢复既有active召回，只处理恢复后的新表达，不补抽暂停期对话。
- **完成目标/问题**：仅用户明确确认后completed，从当前召回中移除；回答成功不等于用户理解。
- **删除来源会话**：先建立屏障再删会话；已保存记忆默认保留，来源显示不可用。已删记忆不会因此再生。
- **删除书籍**：暂停/取消该书在途写入，书级active/candidate标expired，不能召回；用户可在管理页删除，不能自动改成user范围。

暂停时显式“记住”不重新开启自动功能；给出确认操作，用户确认后可保存条目并说明自动记忆仍暂停。删除/更正等明确管理操作可以立即执行，不因暂停而无效。

### 7.3 竞态与失败

- 两个标签页：服务端revision/epoch为准，旧版本409；前端刷新并保留未提交输入，不覆盖用户编辑。
- 新一轮组装MemoryBundle前读取最新状态；不能撤回此前已经发给模型或浏览器的数据，不承诺即时抹去对话中已出现内容。
- 进程重启遗留processing来源标failed，不自动重放不确定是否已计费的模型请求；pending来源仅在enabled、epoch、屏障和原消息仍有效时处理。
- 后处理可重试失败项时仍检查原epoch/屏障，不能绕过删除。唯一来源键和事务状态阻止重复落库，不宣称外部API“恰好计费一次”。
- SQLite空闲页/WAL/既有备份可能仍包含删除前数据；这里保证业务不可召回与防回写，不宣称取证级物理擦除。备份保管和销毁另行明确，不能擅自删用户备份。

## 8. 召回、过期与个性化注入

### 8.1 P2可解释基础召回

1. 检查enabled，关闭返回空MemoryBundle。
2. 只取当前用户active且未过期记录；user范围和当前book范围分别筛选。
3. 当前请求显式要求优先：例如“这次详细讲”覆盖本轮的concise偏好，但不永久改写旧偏好。
4. 全局语言/格式/细节偏好按适用键选择，不要求与问题词面重合。
5. 本书主要目标仅在当前阅读任务适用时注入；open_question、兴趣和事实必须通过主题相关性筛选。
6. 在通过相关性门槛后，才按人工确认、作用域、时效、salience排序；重要度不能把无关条目拉回来。
7. 按共享tokenBudget选择完整条目，允许空集；不截半句造成偏好反转。返回理由沿用global_preference/current_book/relevant_topic。

起步词法匹配可复用基础中英文分词，中文优先双字、排除已记录的停用词；Jaccard阈值在开发集试选0.15/0.25/0.35，不解释为可信概率。P2固定一个经过开发集检查的门槛；最终保留集不用于调参。

### 8.2 生命周期

- 明确用户偏好与身份事实默认不自动过期，由用户更正/删除；过期日期不是模型随意猜的。
- 书级目标由用户完成或用户明确提供结束时间；缺少时间不虚构截止日。
- open_question初始可设置90天无明确重述后过期，候选30天未确认过期；这是产品起始配置，实施前在阶段方案确认，UI显示期限。
- 过期更新由受控维护步骤或读取时有效性判断完成；过期不立刻删除来源或把条目恢复active。
- 相同内容的助手回答、系统复述不刷新last_seen_at；只有用户明确重述才延长有效性。
- 明确重开open_question时，更新为新的90天有效期或用户新指定的有效期；重开reading_goal时使用用户新指定期限，没有则expires_at=NULL，不沿用已经过期的日期。存在同键新active时先给冲突确认，不能违反唯一约束或覆盖更新目标。
- 对completed/expired仅普通提及，不触发重开、续期或active同值刷新分支；来源可标skipped并说明原因。

### 8.3 P3-记忆实验项

- 对比词法召回与可选语义召回；只有跨措辞漏召回有明显数据证据时复用现有Embedding，不增加强制新提供商。
- 对比“只有稳定偏好”“偏好+书级目标”“再加入相关未解问题”的实际回答效果，不把注入更多条当成功。
- 根据实际上下文预算调整记忆条目数/Token占用，基础起点可为最多6条、总计不超过800估算tokens且受调用方预算限制；不是统一模型窗口上限。
- UI显示本次参考的记忆与原因；不宣称模型一定使用了每条注入内容，也不展示隐藏思维链。

## 9. API、UI与后处理结果

### 9.1 公共响应

所有管理接口使用MemoryView，内部normalized_value、来源水位等不直接暴露。单项修改/确认/完成成功统一返回 `{ memory, epoch, memoryChanges }`；单项删除返回 `{ deleted:true, epoch, memoryChanges }`；清空返回 `{ cleared:true, epoch }`。

memoryChanges仅含 `{ id, revision, change }`，change枚举created/updated/candidate/confirmed/completed/deleted/skipped；不重复保存记忆正文。

postProcessing具体为 `{ status, memoryChanges, error }`，status为pending/completed/skipped/failed。请求end只报告当时真实状态，后台之后不再往已结束SSE写事件；前端通过请求查询/记忆页刷新确认完成。

### 9.2 管理操作

| 操作 | 请求 |
| --- | --- |
| 查看 | GET /api/memories，可按bookId/status筛选 |
| 编辑内容 | PUT /api/memories/:id，expectedRevision+content；服务端重新规范化，不允许更改userId |
| 确认候选 | POST /api/memories/:id/confirm，expectedRevision+expectedEpoch；旧候选已失效返回409 |
| 确认legacy | 同confirm，额外classification={kind,key,scope,bookId}，只允许服务端支持且与正文相符的分类；不确定时继续编辑/澄清 |
| 完成目标/问题 | POST /api/memories/:id/complete，expectedRevision；仅active的reading_goal/open_question可用 |
| 删除/清空 | 按共享DELETE接口，分别带expectedRevision/expectedEpoch |
| 暂停/恢复 | PUT /api/memory-settings，enabled+expectedEpoch |

确认候选碰到同键active时，UI先展示将替换的当前值；事务再次核验候选revision和用户epoch，若active在此期间自动变化，其旧候选已在同键更新事务中失效。不能按旧页面静默覆盖新值。

GET /api/memories可列出已失效书籍下的expired条目供删除，不表示仍能访问那本书；召回绝不使用这些记录。404用于记录不存在或越权；版本竞争409 MEMORY_CONFLICT；结构非法400 INVALID_MEMORY。

### 9.3 UI要求

- 列表区分“用户偏好”“本书目标/问题”“待确认”，展示状态、来源、最后更新时间与可用期。
- 自动保存给轻量可撤销提示；撤销按删除屏障执行，不只从DOM移除。
- 冲突卡展示当前值/候选值和来源，提供保留当前、确认新值；保留当前会删除/作废候选并推进屏障。
- 来源查看通过授权会话接口定位用户消息；sourceRange高亮用户question中的文字，不能把书籍Locator套到用户消息上。
- 无需原会话一直保留才能使用已确认记忆；来源已删除要明确显示，不假造“来源已验证”。
- 本次参考区使用MemoryRef，重开历史时已删除显示已删除、版本改变显示已更新，不重新存一份旧正文。
- 编辑/删除/暂停失败必须显示错误并保留正确状态，不在HTTP失败时乐观删除UI后声称成功。

## 10. 实施拆分与验收

| 子任务 | 产出 | 验收 |
| --- | --- | --- |
| M1 迁移与来源 | 表重建、用户状态/来源表、legacy确认前置 | 合成旧库迁移/回滚/自增ID测试通过 |
| M2 写事务与屏障 | 去重、冲突、顺序、人工优先、删除/暂停/完成 | 确定性事务与竞态用例通过，再接模型 |
| M3 API与管理UI | 统一响应、确认/编辑/完成/删除/暂停、来源 | 浏览器操作真实生效，失败/409/切书边界通过 |
| M4 抽取与基础召回 | 三路触发、来源校验、有限批处理、基础阈值 | 合成模型输出测试通过；真实开发集有准确率/召回率/时延/成本 |
| M5 P3-记忆增强 | 相关性与个性化对照，按需语义增强 | 单独确认后实施，保留集评测不退化事实质量 |

P2包含M1–M4；M5不是P2未完成的隐藏尾项。若P1a后处理接口缺失，先补前置阶段方案，不由本模块另建会话消息写入链。

### 10.1 具体测试用例

| ID | 输入/操作 | 预期 |
| --- | --- | --- |
| M-T01 | 旧记忆ID7，旧自增高水位100 | 原文/ID保留、candidate/legacy，新ID大于100；重复迁移不重复 |
| M-T02 | 用户仅说“解释”，选文/助手含“我是一名医生” | 无用户身份记忆，不调用或无有效抽取 |
| M-T03 | “我一直喜欢分点回答” | 明确偏好active、有原话范围，保存后显示确认 |
| M-T04 | “仅这次详细点”“不要记住这个要求” | 只影响本轮，不持久化 |
| M-T05 | “我可能偏爱图示” | candidate，不覆盖旧active |
| M-T06 | “什么是隐喻？” | 不生成用户能力标签 |
| M-T07 | A书“读本书为了写报告” | reading_goal属于A；切B不注入，通用语言偏好仍可共享 |
| M-T08 | A书“我还没理解时间跳跃，希望以后接着讨论” | open_question；一次回答后不自动completed |
| M-T09 | 同义重述/相同request重放 | 同ID或等价归并，无重复条目和重复调度 |
| M-T10 | 旧来源较晚返回，新明确纠错先完成 | 新决定保持；旧epoch/顺序被拒绝 |
| M-T11 | 手动改成详细，普通新推断偏简洁 | 不覆盖人工值，最多candidate |
| M-T12 | 删除时有在途、未完成和跨会话未调度旧消息 | 所有旧来源均不能回写；不是仅挡一个Promise |
| M-T13 | 删除后新消息明确重新表达同偏好 | 新ID越过屏障，可再次保存，体现用户新意图 |
| M-T14 | 暂停期间表达偏好，再恢复 | 暂停不写不召回；恢复不回扫，之后新表达可处理 |
| M-T15 | 两标签页编辑/确认同条旧revision | 后提交旧版本409，前端不覆盖用户输入 |
| M-T16 | 删除来源会话，后台仍在抽取 | 任务失效；已有记忆来源不可用，不重新造来源 |
| M-T17 | 清空后旧candidate确认/后台响应 | 不复活任何旧正文，返回404/409或任务skipped |
| M-T18 | 无关兴趣高salience | 仍不注入；语言/格式偏好按适用性可注入 |
| M-T19 | 候选过期、目标已完成、书已删 | 不进入当前召回；管理页状态准确 |
| M-T20 | LLM非法JSON/错误kind/越权候选ID | 不写入；记录failed或校验错误，不影响已成功回答 |
| M-T21 | 记忆后台失败或尚pending | 不显示“已记住”；请求回答状态不被错误改写 |
| M-T22 | 相同正文在两本书分别有目标 | 不被旧content唯一约束错误合并 |
| M-T23 | 来源事务故障、暂停/重启批量作废来源 | 无部分记忆提交/水位错误推进；来源与请求postProcessing同步，纯跳过返回[]而非永久pending |
| M-T24 | 历史MemoryRef引用已删除/已更新条目 | 不还原旧正文，显示删除/更新，不宣称删除了聊天原话 |
| M-T25 | 旧kind为空或含非法HTML | 合法fact占位、legacy候选，迁移通过CHECK，UI显示待分类且不执行HTML |
| M-T26 | completed/expired问题先普通提及，再明确继续讨论 | 普通提及不重开；明确重开同ID revision+1、active且有效期更新，同键新active冲突时先确认 |

数据隔离、删除防回写、版本冲突、状态与来源结构等确定性用例必须全部通过；真实模型抽取与语义相关性仍以评测结果为准。

### 10.2 质量与论文指标

- 30段合成多轮脚本，10段开发、20段保留，按场景族分组；至少包含两本书切换、明确/推断、纠错、删除和无关信息。
- 对照无长期记忆、当前旧记忆、新治理记忆；使用新会话且相同模型参数，避免同一窗口原话造成假提升。
- P2建议目标：抽取Precision≥90%，同时报告Recall，不能靠完全不保存取得高Precision；无关误注入≤5%。
- P3建议目标：适用偏好遵从≥90%、旧偏好误用≤5%，同时检查事实正确率不下降。阈值在正式测试前冻结。
- 记录每轮抽取调用数、用户信息到实际可用的P50/P95、候选确认数量、合并/纠错成功率与tokens；展示调用下降与漏抽之间的取舍。
- 素材：来源流转图、记忆状态图、表ER图、同义/冲突规则表、跨书共享/隔离截图、删除竞态时序图、三组效果/成本对比。

## 11. 交接与限制

执行者提交迁移/接口变化、测试命令与退出码、浏览器步骤、实际模型配置和数据集版本、失败样本及未测项，放docs/。不能只提供“新增记忆函数”的代码说明。

仅词法门槛不是最终语义理解，候选归属也可能判错；应通过确认UI与可追溯证据降低影响。不要承诺“越聊越懂”必然单调提升，更不能用用户资料条数替代真实效果。

本方案与共享约定共同构成交接输入，仍需当阶段确认后才实施；不把文档中的数据库重建步骤直接运行在用户现有data.db上。
