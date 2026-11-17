/**
 * RAG 离线回归（P1a 统一入口）：建库模式、混合/BM25检索、Embedding失败降级、
 * 无索引、删除、KNN 范围微实验、跨用户隔离。检索证据经 evidence 事件返回。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A, BOOK_B } = require('./helpers/fixtures');

let srv, fake, user, bookA;

async function uploadBook(token, title, content) {
    const form = new FormData();
    form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
    const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()).book;
}
async function setEmbedding(provider, extra = {}) {
    const res = await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider, ...extra } });
    assert.strictEqual(res.status, 200, res.text);
}
async function indexBook(bookId) {
    const res = await api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body: {} });
    assert.strictEqual(res.status, 200, res.text);
    return res.data;
}
async function searchEvidence(question, bookId, token = user.token) {
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: question } }] });
    const stream = await postSSE(srv.url, '/api/ask-stream', { token, body: { requestId: crypto.randomUUID(), question, bookId, provider: 'fakeprov' } });
    const ev = stream.events.find(e => e.type === 'evidence');
    const tr = stream.events.find(e => e.type === 'tool_result' && e.data.name === 'searchInBook');
    return { events: stream.events, evidence: ev ? ev.data.items : [], toolResult: tr ? tr.data : null };
}

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p0-rag');
    const prov = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-rag-0123456789abcdef' } });
    assert.strictEqual(prov.status, 200, prov.text);
    bookA = await uploadBook(user.token, '测试书A', BOOK_A);
});
after(async () => { if (srv) await srv.stop(); if (fake) await fake.close(); });

test('配置阿里云假Embedding后建库为 embedding+bm25', async () => {
    await setEmbedding('aliyun', { aliyunBaseUrl: `${fake.url}/v1`, aliyunModel: 'fake-embed', aliyunApiKey: 'sk-p0-embed-0123456789abcdef' });
    const result = await indexBook(bookA.id);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.active.mode, 'embedding+bm25');
    assert.strictEqual(result.usable, true);
    const status = await api(srv.url, `/api/books/${bookA.id}/index-status`, { token: user.token });
    assert.strictEqual(status.data.active.mode, 'embedding+bm25');
    assert.strictEqual(status.data.usable, true);
});

test('Agent 检索命中目标段落，证据带 locator 且方法含 hybrid/vector', async () => {
    const { evidence } = await searchEvidence('青色灯塔的守塔人是谁', bookA.id);
    assert.ok(evidence.length > 0, '应有证据');
    assert.ok(evidence.some(e => /hybrid|vector/.test(e.method)), `证据方法应含hybrid/vector: ${evidence.map(e => e.method)}`);
    assert.ok(evidence.map(e => e.text).join('').includes('老周'));
    // P1b：书内证据必须有可核验 locator，text 等于原文 slice
    const bookResp = await api(srv.url, `/api/books/${bookA.id}`, { token: user.token });
    const content = bookResp.data.content;
    for (const e of evidence) {
        assert.ok(e.locator, '书内证据应有 locator');
        assert.strictEqual(e.verified, true, 'locator 与当前内容一致应 verified');
        assert.strictEqual(e.text, content.slice(e.locator.start, e.locator.end));
        assert.strictEqual(e.locator.contentHash, bookResp.data.contentHash);
    }
});

test('关闭Embedding重建后纯BM25，证据方法为 bm25', async () => {
    await setEmbedding('off');
    const result = await indexBook(bookA.id);
    assert.strictEqual(result.active.mode, 'bm25');
    const { evidence } = await searchEvidence('青色灯塔的守塔人是谁', bookA.id);
    assert.ok(evidence.some(e => e.method === 'bm25'), `证据方法应为bm25: ${evidence.map(e => e.method)}`);
    assert.ok(evidence.map(e => e.text).join('').includes('老周'));
});

test('Embedding服务失败时重建保留旧索引并报告警告', async () => {
    await setEmbedding('aliyun', { aliyunBaseUrl: `${fake.url}/v1`, aliyunModel: 'fake-embed', aliyunApiKey: 'sk-p0-embed-0123456789abcdef' });
    await fake.control({ embedError: { status: 500, body: { error: { message: 'fake embedding outage' } } } });
    const result = await indexBook(bookA.id);
    // 此前已有 active（BM25），重建失败应保留旧索引而非静默替换
    assert.strictEqual(result.success, false);
    assert.ok(result.warnings.some(w => w.code === 'EMBED_FAILED'));
    assert.strictEqual(result.usable, true, '旧 active 仍可用');
    await fake.control({ embedError: null });
});

test('无索引时检索返回 unavailable，不报错', async () => {
    await api(srv.url, `/api/books/${bookA.id}/index`, { method: 'DELETE', token: user.token });
    const status = await api(srv.url, `/api/books/${bookA.id}/index-status`, { token: user.token });
    assert.strictEqual(status.data.usable, false);
    assert.strictEqual(status.data.active, null);
    const { evidence, toolResult } = await searchEvidence('青色灯塔的守塔人是谁', bookA.id);
    assert.strictEqual(evidence.length, 0);
    assert.ok(toolResult && ['empty', 'ok', 'unavailable'].includes(toolResult.status));
});

test('KNN 范围过滤微实验（内存库复现）', () => {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[1024])');
    db.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, user_id TEXT, book_id TEXT)');
    const DIM = 1024;
    const vec = (fill) => { const a = new Array(DIM).fill(0); a[0] = fill; return Buffer.from(new Float32Array(a).buffer); };
    const insV = db.prepare('INSERT INTO v (rowid, embedding) VALUES (?, ?)');
    const insC = db.prepare('INSERT INTO chunks (id, user_id, book_id) VALUES (?, ?, ?)');
    for (let i = 1; i <= 42; i++) {
        const owner = i <= 15 ? ['u1', 'other'] : i <= 30 ? ['u2', 'other'] : ['u1', 'target'];
        insC.run(i, owner[0], owner[1]);
        insV.run(BigInt(i), vec(i <= 30 ? 0.001 * i : 0.5 + 0.001 * i));
    }
    const q = vec(0);
    const scoped = db.prepare(`SELECT v.rowid AS id FROM v WHERE v.embedding MATCH ? AND v.rowid IN (SELECT id FROM chunks WHERE user_id = ? AND book_id = ?) AND k = 10 ORDER BY v.distance`).all(q, 'u1', 'target').map(r => Number(r.id));
    assert.strictEqual(scoped.length, 10);
    assert.ok(scoped.every(id => id >= 31 && id <= 42));
    const empty = db.prepare(`SELECT v.rowid AS id FROM v WHERE v.embedding MATCH ? AND v.rowid IN (SELECT id FROM chunks WHERE user_id = ? AND book_id = ?) AND k = 10`).all(q, 'u2', 'target');
    assert.strictEqual(empty.length, 0);
    db.close();
});

test('跨用户RAG隔离：B检索不到A书独特标记', async () => {
    const userB = await registerUser(srv.url, 'p0-rag-bob');
    const provB = await api(srv.url, '/api/providers', { method: 'POST', token: userB.token, body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-rag-0123456789abcdef' } });
    assert.strictEqual(provB.status, 200, provB.text);
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: userB.token, body: { provider: 'aliyun', aliyunBaseUrl: `${fake.url}/v1`, aliyunModel: 'fake-embed', aliyunApiKey: 'sk-p0-embed-0123456789abcdef' } });
    const bookB = await uploadBook(userB.token, '测试书B', BOOK_B);
    await api(srv.url, `/api/books/${bookB.id}/index`, { method: 'POST', token: userB.token, body: {} });
    const { evidence } = await searchEvidence('青色灯塔 老周 航海日志', bookB.id, userB.token);
    const texts = evidence.map(e => e.text).join('');
    assert.ok(!texts.includes('老周'));
    assert.ok(!texts.includes('航海日志'));
});