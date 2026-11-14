/**
 * P1a A1 单元测试：web_001 迁移、请求存储/指纹/幂等、消息 metadata 与完成轮次过滤。
 * 使用进程级临时数据根，不触碰真实库。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-p1a-unit-'));
process.env.READER_DATA_ROOT = tmp;

const database = require('../database');
const conv = require('../conversation');
const rs = require('../request-store');

let db;
before(async () => { db = await database.initDB(); });
after(() => { try { db.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

function mkUser(id) {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, id, 'x');
    return id;
}

test('web_001 迁移：requests 表与 messages 新列存在', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('requests'));
    assert.ok(tables.includes('schema_migrations'));
    const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    for (const c of ['request_id', 'status', 'metadata']) assert.ok(cols.includes(c), `缺少列 ${c}`);
    const applied = db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id);
    assert.ok(applied.includes('web_001_request_contract'));
});

test('迁移幂等：重复 initDB 不重复应用', async () => {
    db.close();
    db = await database.initDB();
    const n = db.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE id='web_001_request_contract'").get().c;
    assert.strictEqual(n, 1);
});

test('请求指纹稳定且与语义字段相关', () => {
    const a = rs.computeFingerprint({ question: '你好', bookId: 'b1', selection: { text: '原文' } });
    const b = rs.computeFingerprint({ question: '你好', bookId: 'b1', selection: { text: '原文' }, action: 'ask' });
    assert.strictEqual(a, b, '省略字段默认值应稳定');
    const c = rs.computeFingerprint({ question: '你好吗', bookId: 'b1' });
    assert.notStrictEqual(a, c);
});

test('请求 CRUD 与终态判定', () => {
    const uid = mkUser('u-req');
    const fp = rs.computeFingerprint({ question: 'q' });
    rs.createRequest({ userId: uid, requestId: 'r1', fingerprint: fp, conversationId: 'c1' });
    let r = rs.getRequest(uid, 'r1');
    assert.strictEqual(r.status, 'running');
    assert.ok(!rs.isTerminal(r.status));
    rs.updateRequest(uid, 'r1', { status: 'completed', postProcessing: JSON.stringify({ status: 'pending' }) });
    r = rs.getRequest(uid, 'r1');
    assert.strictEqual(r.status, 'completed');
    assert.ok(rs.isTerminal(r.status));
    assert.ok(!rs.isTerminal('running'));
});

test('重启遗留 running 转 interrupted', () => {
    const uid = mkUser('u-stale');
    rs.createRequest({ userId: uid, requestId: 'rs1', fingerprint: 'fp' });
    const n = rs.interruptStaleRunning();
    assert.ok(n >= 1);
    assert.strictEqual(rs.getRequest(uid, 'rs1').status, 'interrupted');
});

test('消息 metadata/status 与完成轮次过滤', () => {
    const uid = mkUser('u-msg');
    const c = conv.createConversation(uid, null, null, null);
    const u = conv.appendMessage(c.id, { role: 'user', content: '问题', requestId: 'r2', metadata: { origin: 'user_text', selection: { text: '选文' } } });
    const a = conv.appendMessage(c.id, { role: 'assistant', content: '', status: 'running', requestId: 'r2' });
    assert.ok(u.id && a.id);
    // running 助手消息不进模型历史
    let msgs = conv.buildModelMessages(conv.getConversation(uid, c.id), 'sys');
    assert.ok(!msgs.some(m => m.role === 'assistant' && m.content === ''), 'running 空助手消息不应进上下文');
    // 完成后更新正文与 metadata
    conv.updateMessage(a.id, { content: '最终答案', status: 'completed', metadata: { schemaVersion: 1, answerKind: 'answer' } });
    const stored = conv.getMessageById(a.id);
    assert.strictEqual(stored.status, 'completed');
    assert.strictEqual(stored.content, '最终答案');
    assert.ok(JSON.parse(stored.metadata).answerKind === 'answer');
    msgs = conv.buildModelMessages(conv.getConversation(uid, c.id), 'sys');
    assert.ok(msgs.some(m => m.role === 'assistant' && m.content === '最终答案'), '完成后应进上下文');
});