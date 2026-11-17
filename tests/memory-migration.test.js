/**
 * P2 M1：web_003_memory_lifecycle 迁移测试（合成旧库，不触碰业务数据）。
 * M-T01 ID/高水位保留与重复迁移；M-T25 非法kind占位与备份；回滚原子性；
 * 部分唯一索引/CHECK 约束；每用户屏障初始化。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { MIGRATIONS, applyMigrations } = require('../database');

const OLD_SCHEMA = `
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT, title TEXT, status TEXT DEFAULT 'active', summary TEXT DEFAULT '', summary_upto INTEGER DEFAULT 0, token_estimate INTEGER DEFAULT 0, provider TEXT, model TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT, token_estimate INTEGER DEFAULT 0, in_window INTEGER DEFAULT 1, created_at TEXT, request_id TEXT, status TEXT DEFAULT 'completed', metadata TEXT);
    CREATE TABLE user_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT DEFAULT 'fact',
        content TEXT NOT NULL,
        salience REAL DEFAULT 1.0,
        source_conv TEXT,
        embedding TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, content)
    );
    CREATE TABLE rag_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, book_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chapter TEXT, text TEXT NOT NULL);
    CREATE TABLE rag_index_meta (user_id TEXT NOT NULL, book_id TEXT NOT NULL, mode TEXT NOT NULL, embed_provider TEXT, embed_model TEXT, dims INTEGER, chunk_count INTEGER DEFAULT 0, indexed_at TEXT, PRIMARY KEY (user_id, book_id));
`;

function makeOldDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    db.exec("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x'), ('u2', 'bob', 'x')");
    db.exec("INSERT INTO conversations (id, user_id, book_id) VALUES ('c1', 'u1', 'b1'), ('c2', 'u1', NULL)");
    return db;
}

function addLegacy(db, { id, userId = 'u1', kind = 'preference', content, salience = 0.8, sourceConv = 'c1', embedding = null }) {
    db.prepare('INSERT INTO user_memories (id, user_id, kind, content, salience, source_conv, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, kind, content, salience, sourceConv, embedding, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
}

const mem003 = MIGRATIONS.find(m => m.id === 'web_003_memory_lifecycle');

test('M-T01 旧ID7/高水位100：原文与ID保留、candidate/legacy，新ID大于100，重复迁移不重复', () => {
    const db = makeOldDb();
    addLegacy(db, { id: 7, content: '用户喜欢分点回答', embedding: '[0.1,0.2]' });
    db.exec("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'user_memories'");
    // u1 有用户消息最大ID=5；u2 无消息
    db.exec("INSERT INTO messages (id, conversation_id, seq, role, content) VALUES (3, 'c1', 1, 'user', 'q1'), (5, 'c1', 2, 'user', 'q2'), (6, 'c1', 3, 'assistant', 'a')");

    applyMigrations(db);

    const row = db.prepare('SELECT * FROM user_memories WHERE id = 7').get();
    assert.strictEqual(row.content, '用户喜欢分点回答');
    assert.strictEqual(row.status, 'candidate');
    assert.strictEqual(row.source_type, 'legacy');
    assert.strictEqual(row.key, 'legacy:7');
    assert.strictEqual(row.revision, 1);
    assert.strictEqual(row.scope, 'user');
    assert.strictEqual(row.book_id, null);
    assert.strictEqual(row.normalized_value, null);
    assert.strictEqual(row.source_conv, 'c1');
    assert.strictEqual(row.source_message_id, null);
    assert.strictEqual(row.created_at, '2026-01-01T00:00:00.000Z');

    const info = db.prepare("INSERT INTO user_memories (user_id, kind, scope, key, content, status, revision, source_type) VALUES ('u1', 'fact', 'user', 'fact.role', '新记忆', 'active', 1, 'user_message')").run();
    assert.ok(Number(info.lastInsertRowid) > 100, `新ID应大于旧高水位100，实际 ${info.lastInsertRowid}`);

    // 屏障初始化：u1=5（最大用户消息ID），u2=0
    assert.strictEqual(db.prepare('SELECT blocked_through_message_id b FROM memory_user_state WHERE user_id = ?').get('u1').b, 5);
    assert.strictEqual(db.prepare('SELECT blocked_through_message_id b FROM memory_user_state WHERE user_id = ?').get('u2').b, 0);

    // 重复迁移幂等
    const before = db.prepare('SELECT COUNT(*) c FROM user_memories').get().c;
    applyMigrations(db);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM user_memories').get().c, before);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE id = ?').get('web_003_memory_lifecycle').c, 1);
    db.close();
});

test('M-T25 旧kind为空/非法HTML/大写：合法fact占位、legacy候选、原值仅存备份、正文不变', () => {
    const db = makeOldDb();
    addLegacy(db, { id: 1, kind: '', content: '空kind样本' });
    addLegacy(db, { id: 2, kind: '<img src=x onerror=alert(1)>', content: '非法kind样本' });
    addLegacy(db, { id: 3, kind: 'FACT', content: '大写kind样本' });
    addLegacy(db, { id: 4, kind: 'interest', content: '正常文本<img src=x onerror="window.__x=1">结束' });

    applyMigrations(db);

    for (const id of [1, 2, 3]) {
        const r = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id);
        assert.strictEqual(r.kind, 'fact', `id=${id} 应映射为占位fact`);
        assert.strictEqual(r.status, 'candidate');
        assert.strictEqual(r.source_type, 'legacy');
    }
    assert.strictEqual(db.prepare('SELECT kind FROM user_memories WHERE id = 4').get().kind, 'interest');
    assert.strictEqual(db.prepare('SELECT content FROM user_memories WHERE id = 4').get().content, '正常文本<img src=x onerror="window.__x=1">结束');
    // 备份保留原非法值与embedding
    assert.strictEqual(db.prepare('SELECT kind FROM user_memories_legacy_backup WHERE id = 2').get().kind, '<img src=x onerror=alert(1)>');
    db.close();
});

test('迁移事务失败整体回滚：旧表/数据/登记不变', () => {
    const db = makeOldDb();
    addLegacy(db, { id: 7, content: '回滚样本' });
    const tx = db.transaction(() => {
        mem003.up(db);
        throw new Error('模拟迁移中途失败');
    });
    assert.throws(() => tx(), /模拟迁移中途失败/);
    assert.strictEqual(db.prepare('SELECT content FROM user_memories WHERE id = 7').get().content, '回滚样本');
    assert.ok(db.prepare("PRAGMA table_info(user_memories)").all().every(c => c.name !== 'status'));
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('memory_user_state','memory_sources','user_memories_new')").get().c, 0);
    db.close();
});

test('新约束：用户/书级active部分唯一、scope/book一致、goal限book、revision>0、同正文跨书合法', () => {
    const db = makeOldDb();
    applyMigrations(db);
    const ins = db.prepare("INSERT INTO user_memories (user_id, kind, scope, book_id, key, content, status, revision, source_type) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, 'user_message')");
    ins.run('u1', 'preference', 'user', null, 'preference.answer_length', '简洁');
    assert.throws(() => ins.run('u1', 'preference', 'user', null, 'preference.answer_length', '详细'), /UNIQUE/);
    // 同键不同书合法（M-T22 结构基础）
    ins.run('u1', 'reading_goal', 'book', 'b1', 'reading_goal.primary', '写报告');
    ins.run('u1', 'reading_goal', 'book', 'b2', 'reading_goal.primary', '写报告');
    assert.throws(() => ins.run('u1', 'reading_goal', 'book', 'b1', 'reading_goal.primary', '另一目标'), /UNIQUE/);
    // candidate 可与同键 active 共存
    db.prepare("INSERT INTO user_memories (user_id, kind, scope, key, content, status, revision, source_type) VALUES ('u1', 'preference', 'user', 'preference.answer_length', '候选详细', 'candidate', 1, 'user_message')").run();
    // CHECK 约束
    assert.throws(() => ins.run('u1', 'preference', 'book', null, 'preference.language', 'zh'), /CHECK/);
    assert.throws(() => ins.run('u1', 'preference', 'user', 'b1', 'preference.language', 'zh'), /CHECK/);
    assert.throws(() => ins.run('u1', 'reading_goal', 'user', null, 'reading_goal.primary', 'x'), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO user_memories (user_id, kind, scope, key, content, status, revision, source_type) VALUES ('u1', 'fact', 'user', 'fact.role', 'x', 'active', 0, 'user_message')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO user_memories (user_id, kind, scope, key, content, status, revision, source_type, source_start, source_end) VALUES ('u1', 'fact', 'user', 'fact.role', 'x', 'active', 1, 'user_message', 5, 3)").run(), /CHECK/);
    // 旧 content 唯一约束已取消：同用户同正文不同键可并存
    db.prepare("INSERT INTO user_memories (user_id, kind, scope, key, content, status, revision, source_type) VALUES ('u1', 'fact', 'user', 'fact.role', '写报告', 'active', 1, 'user_message')").run();
    db.close();
});

test('迁移不继承旧embedding为新索引，备份保留原值', () => {
    const db = makeOldDb();
    addLegacy(db, { id: 9, content: '带向量旧记忆', embedding: '[0.5,0.6,0.7]' });
    applyMigrations(db);
    const cols = db.prepare('PRAGMA table_info(user_memories)').all().map(c => c.name);
    assert.ok(!cols.includes('embedding'));
    assert.strictEqual(db.prepare('SELECT embedding FROM user_memories_legacy_backup WHERE id = 9').get().embedding, '[0.5,0.6,0.7]');
    db.close();
});