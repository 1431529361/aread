# Web 毕设改造前检查记录

日期：2026-10-28。性质：只读代码审查、语法检查与隔离的内存数据库微实验，不是完整功能测试或性能基准。

## 1. 边界与操作记录

- 当前分支确认是 `qoder/web-thesis`；开始时 `git status --short` 无输出。
- 未切换或修改 `qoder/android-app`，未读取或修改 `mobile/` 内容。
- 未启动应用服务，未调用实际 LLM/Embedding API，未读取密钥内容。
- 未打开或修改业务 `data.db`，未删除书籍、环境配置或旧索引目录。
- 本轮仓库写入仅为用户要求的 `docs/` 文档，未修改业务源代码、依赖或 Git 配置，未提交或推送。
- `git check-ignore` 确认 `.env`、`data.db`、`books/`、`rag_index/`、`mobile/` 当前均被忽略；这不是敏感信息全仓扫描结论。

## 2. 已阅读的代码与资料

主入口和前端重点链路：`server.js`、`public/app.js`、`public/index.html`；模块审查：`rag.js`、`embedding.js`、`conversation.js`、`database.js`、`agent.js`、`orchestrator.js`、`llm-client.js`、`text-utils.js`、`tools/`；另只读认证模块与依赖清单。

文档：`README.md`、`CLAUDE.md`、`INTERVIEW_GUIDE.md`，以及项目知识中心架构条目。

文档一致性结论：

- `database.js:1` 使用 better-sqlite3，知识中心条目和 `CLAUDE.md:27` 的 sql.js 架构描述已经过时。
- `INTERVIEW_GUIDE.md:27` 描述五个工具，而当前工具注册目录中为三个检索工具。
- `INTERVIEW_GUIDE.md:106` 描述旧 JSON 索引，当前主链路已使用 SQLite 分块、向量和元信息表。
- `INTERVIEW_GUIDE.md:489-498` 的延迟、准确率等数字明确属于经验估算，不能用作论文实验结果。

## 3. 语法检查

执行命令：

```bash
node --check server.js && node --check rag.js && node --check agent.js && node --check conversation.js && node --check orchestrator.js && node --check llm-client.js && node --check database.js && node --check public/app.js
```

结果：退出码 0，无语法错误输出。

限制：语法通过不能证明接口、流式响应、检索质量、记忆效果或浏览器交互正确。

## 4. KNN 范围过滤微实验

### 待核实假设

“当前代码先对所有用户和所有书籍做全局 Top-K，再按书过滤，导致书内候选被挤掉。”

代码位置：`rag.js:285-292`。实际 SQL 已包含按 `user_id + book_id` 限定的 `rowid IN`。虚拟表的过滤执行不能仅根据 SQL 书写顺序判断。

### 环境

以执行命令实际报告为准：

| 项目 | 值 |
| --- | --- |
| Node.js | v24.14.0 |
| SQLite | 3.53.2 |
| sqlite-vec | v0.1.9 |
| 数据库 | `:memory:`，与业务数据库无连接 |
| 向量维度 | 1024 |

### 设计

- 插入 42 个合成向量，查询向量为全零。
- ID 1–15 属于同用户的其他书；ID 16–30 属于其他用户的其他书；距离均很近。
- ID 31–42 属于目标用户 u1 的 target 书；距离均比前 30 条远。
- 分别执行无范围约束的全局 Top-10、与生产查询相同形状的书内 Top-10，以及不存在所属关系的空范围查询。
- 若是先全局 Top-10 再过滤，目标书查询会返回空；若候选范围有效，应该返回 ID 31–40。

### 实际结果

| 查询 | 实际结果 |
| --- | --- |
| 无范围约束，全局 Top-10 | ID 1–10 |
| u1 + target，书内 Top-10 | ID 31–40，共 10 条 |
| u2 + target，空范围 | 0 条 |
| 本例目标范围断言 | 通过 |

结论：本机当前版本及该构造数据上，未复现“全局 KNN 后过滤导致目标书召回不足”。不把它直接列为已确认缺陷或安排向量存储重构。

限制：本例不等同于完整租户隔离、安全或性能验证；没有覆盖并发重建、删除、真实模型向量、所有查询形态和大规模数据。后续仍应保留范围约束回归测试。

### 可复现命令（Git Bash）

```bash
node <<'NODE'
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
try {
  sqliteVec.load(db);
  db.exec('CREATE TABLE rag_chunks (id INTEGER PRIMARY KEY, user_id TEXT, book_id TEXT); CREATE VIRTUAL TABLE rag_vec USING vec0(embedding float[1024]);');
  const addChunk = db.prepare('INSERT INTO rag_chunks VALUES (?, ?, ?)');
  const addVec = db.prepare('INSERT INTO rag_vec(rowid, embedding) VALUES (?, ?)');
  const vector = n => {
    const values = new Float32Array(1024);
    values[0] = n;
    return Buffer.from(values.buffer);
  };
  for (let i = 1; i <= 42; i++) {
    const target = i > 30;
    addChunk.run(i, target || i <= 15 ? 'u1' : 'u2', target ? 'target' : 'other');
    addVec.run(BigInt(i), vector(target ? i : i / 100));
  }
  const query = `SELECT v.rowid AS id, v.distance AS distance
    FROM rag_vec v WHERE v.embedding MATCH ?
    AND v.rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ?)
    AND k = ? ORDER BY v.distance`;
  const scoped = db.prepare(query).all(vector(0), 'u1', 'target', 10);
  const global = db.prepare('SELECT rowid AS id FROM rag_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(vector(0), 10);
  const empty = db.prepare(query).all(vector(0), 'u2', 'target', 10);
  console.log(JSON.stringify({
    node: process.version,
    sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
    vec: db.prepare('SELECT vec_version() AS version').get().version,
    scopedIds: scoped.map(r => r.id),
    globalIds: global.map(r => r.id),
    emptyScopeCount: empty.length,
    scopedCount: scoped.length,
    passesTargetScope: scoped.length === 10 && scoped.every(r => r.id > 30) && empty.length === 0
  }, null, 2));
} finally {
  db.close();
}
NODE
```

测试脚本首轮曾因 Number 绑定 rowid 被 vec0 视为 REAL 而失败；改为 BigInt 后完成实验。项目本身在 `rag.js:231-232` 已使用 BigInt，因此这次脚本绑定错误不是应用缺陷。

## 5. 本轮没有验证的事项

- 浏览器登录、阅读、问答、引用、记忆和任务编排的端到端行为。
- 当前 API 密钥是否有效、模型是否支持工具调用、在线延迟和调用成本。
- 真实书籍的 Recall@K、回答正确率、引用支撑率、记忆抽取与偏好遵从率。
- 并发压缩、记忆删除后异步回写、建库中断与恢复等故障场景。
- 全面渗透测试或依赖漏洞扫描。

这些属于确认后分阶段实施与验证的工作，不应在论文或交付汇报中写成已通过。
