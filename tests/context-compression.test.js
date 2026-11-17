/**
 * 上下文压缩策略确定性测试（进程内隔离临时库，不联网）：
 * 轮次对齐边界（孤儿 tool 修复）、保留预算下限、摘要硬上限、LLM 失败确定性兜底、自动触发阈值。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let root, database, conv, llmClient, db;
const U1 = 'u-comp-1';
let bookId;

const llmStub = { mode: 'ok', text: '【用户目标】测试\n【已确认事实与偏好】无\n【关键结论】无\n【未解问题】无', calls: 0 };

function makeConv() {
    return conv.createConversation(U1, bookId, null, null).id;
}
function addRound(convId, userText, assistantText, { withTool = false } = {}) {
    conv.appendMessage(convId, { role: 'user', content: userText, status: 'completed' });
    if (withTool) {
        const callId = 'call_' + crypto.randomUUID().slice(0, 8);
        conv.appendMessage(convId, {
            role: 'assistant', content: null, status: 'completed',
            tool_calls: [{ id: callId, type: 'function', function: { name: 'search_book', arguments: '{"query":"x"}' } }]
        });
        conv.appendMessage(convId, { role: 'tool', content: '工具结果片段', tool_call_id: callId, status: 'completed' });
    }
    conv.appendMessage(convId, { role: 'assistant', content: assistantText, status: 'completed' });
}
function windowMsgs(convId) {
    return conv.getConversationMessages(convId, { windowOnly: true });
}
function assertNoOrphanTool(msgs) {
    const pending = new Set();
    for (const m of msgs) {
        if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) pending.add(tc.id);
        if (m.role === 'tool') {
            assert.ok(pending.size > 0, 'tool 消息的 assistant tool_calls 必须同在工作窗口');
            pending.clear();
        }
    }
}
function longText(chars) { return '这是一段用于测试上下文压缩的较长回答内容。'.repeat(Math.ceil(chars / 20)).slice(0, chars); }

before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-comp-'));
    process.env.READER_DATA_ROOT = root;
    database = require('../database');
    conv = require('../conversation');
    llmClient = require('../llm-client');
    llmClient.complete = async () => {
        llmStub.calls++;
        if (llmStub.mode === 'throw') throw new Error('stub LLM failure');
        return llmStub.text;
    };
    db = await database.initDB();
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(U1, U1, 'x');
    bookId = 'book-' + crypto.randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO books_meta (id, user_id, title, filename, original_name, format, size, size_formatted)
                VALUES (?, ?, ?, ?, ?, 'TXT', 10, '1 KB')`).run(bookId, U1, '压缩测试书', bookId + '.txt', '压缩测试书.txt');
});
after(() => {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('切点纯函数：旧固定6条会孤儿 tool 的场景，新切点对齐轮次且保留配对', () => {
    // 0基: u a u a(tc) tool u a u a u —— 旧算法 last6 从 tool 开始
    const roles = ['user', 'assistant', 'user', 'assistant', 'tool', 'user', 'assistant', 'user', 'assistant', 'user'];
    const msgs = roles.map((role, i) => ({ role, seq: i + 1, token_estimate: 10000, tool_calls: role === 'assistant' && i === 3 ? [{ id: 't1' }] : null }));
    const oldRecent = msgs.slice(msgs.length - 6);
    assert.strictEqual(oldRecent[0].role, 'tool'); // 旧行为确会孤儿
    const cut = conv.chooseCompressionCut(msgs, 262144);
    assert.ok(cut > 0);
    const recent = msgs.slice(cut);
    assert.strictEqual(recent[0].role, 'user');
    assertNoOrphanTool(recent);
    assert.ok(recent.length >= 6);
    assert.ok(recent.filter(m => m.role === 'user').length >= 3);
});

test('切点纯函数：token 预算生效且下限不突破；轮次不足返回 -1', () => {
    const mk = (n, per) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', seq: i + 1, token_estimate: per }));
    // 每条 100K token：预算只容 1 条，但下限强制 ≥6 条 / 3 轮
    const big = mk(10, 100000);
    const cut = conv.chooseCompressionCut(big, 262144);
    assert.ok(cut > 0);
    assert.ok(big.length - cut >= 6);
    assert.ok(big.slice(cut).filter(m => m.role === 'user').length >= 3);
    // 预算宽松时保留预算内的近期原文（切点早于下限）
    const small = mk(20, 1000); // 总 20K < 预算 39K → 无可压缩
    assert.strictEqual(conv.chooseCompressionCut(small, 262144), -1);
    const mid = mk(20, 4000); // 总 80K > 预算 → 切点由预算决定
    const cutMid = conv.chooseCompressionCut(mid, 262144);
    assert.ok(cutMid > 0 && cutMid < 20 - 6);
    // 仅 3 轮 → 不足
    assert.strictEqual(conv.chooseCompressionCut(mk(6, 100000), 262144), -1);
});

test('端到端压缩：结构化摘要落库、窗口轮次完整、token 核算一致、旧消息可回溯', async () => {
    llmStub.mode = 'ok'; llmStub.calls = 0;
    const cid = makeConv();
    for (let i = 1; i <= 5; i++) addRound(cid, `问题${i}：请分析第${i}章`, longText(20000), { withTool: i === 2 });
    const before = db.prepare('SELECT token_estimate FROM conversations WHERE id = ?').get(cid).token_estimate;
    const r = await conv.compressConversation({ model: null }, db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid));
    assert.strictEqual(r.compressed, true);
    assert.ok(llmStub.calls >= 1);
    assert.ok(r.summary.includes('【用户目标】'));
    assert.ok(r.after < r.before);
    const recent = windowMsgs(cid);
    assert.strictEqual(recent[0].role, 'user');
    assertNoOrphanTool(recent);
    const stored = db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
    const recentTokens = recent.reduce((s, m) => s + (m.token_estimate || 0), 0);
    assert.strictEqual(stored.token_estimate, conv.estimateTokens(stored.summary) + recentTokens);
    assert.ok(stored.summary_upto > 0);
    const all = conv.getConversationMessages(cid);
    assert.ok(all.length > recent.length); // 旧消息仍在库中
    const outOfWindow = all.filter(m => m.in_window === 0);
    assert.ok(outOfWindow.length > 0 && outOfWindow.every(m => m.seq <= stored.summary_upto));
});

test('摘要硬上限：超长模型输出被截断到 2000 token 内', async () => {
    llmStub.mode = 'ok';
    llmStub.text = longText(12000);
    const cid = makeConv();
    for (let i = 1; i <= 5; i++) addRound(cid, `问${i}`, longText(20000));
    const r = await conv.compressConversation({ model: null }, db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid));
    assert.strictEqual(r.compressed, true);
    assert.ok(conv.estimateTokens(r.summary) <= 2000);
    llmStub.text = '【用户目标】测试\n【已确认事实与偏好】无\n【关键结论】无\n【未解问题】无';
});

test('LLM 失败兜底：逐轮丢弃最旧轮次降窗，summary/summary_upto 不推进，下限不突破', async () => {
    llmStub.mode = 'throw';
    const cid = makeConv();
    for (let i = 1; i <= 6; i++) addRound(cid, `问${i}`, longText(60000));
    const limit = conv.getModelContextLimit(null);
    const before = db.prepare('SELECT token_estimate FROM conversations WHERE id = ?').get(cid).token_estimate;
    assert.ok(before > limit * 0.7 - 2500, '前置：窗口须超触发阈值');
    const r = await conv.compressConversation({ model: null }, db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid));
    assert.strictEqual(r.compressed, true);
    assert.strictEqual(r.fallback, 'drop_oldest');
    const stored = db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
    assert.ok(!stored.summary, '兜底不写摘要');
    assert.strictEqual(stored.summary_upto, 0);
    assert.ok(stored.token_estimate <= limit * 0.7 - 2500);
    const recent = windowMsgs(cid);
    assert.ok(recent.filter(m => m.role === 'user').length >= 3);
    assert.ok(recent.length >= 6);
    assert.strictEqual(recent[0].role, 'user');
    llmStub.mode = 'ok';
});

test('自动压缩阈值：低于 70% 不触发，高于触发', async () => {
    llmStub.mode = 'ok';
    const cid = makeConv();
    for (let i = 1; i <= 5; i++) addRound(cid, `问${i}`, longText(20000));
    const limit = conv.getModelContextLimit(null);
    db.prepare('UPDATE conversations SET token_estimate = ? WHERE id = ?').run(Math.floor(limit * 0.5), cid);
    const low = await conv.maybeAutoCompress({ model: null }, db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid));
    assert.strictEqual(low.compressed, false);
    db.prepare('UPDATE conversations SET token_estimate = ? WHERE id = ?').run(Math.floor(limit * 0.8), cid);
    const high = await conv.maybeAutoCompress({ model: null }, db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid));
    assert.strictEqual(high.compressed, true);
});
