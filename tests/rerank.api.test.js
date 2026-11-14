/**
 * 自定义 Embedding + 可选重排离线回归（ER-01~05）。
 * 使用本地假模型（含 /embeddings 与 /rerank），不访问外网。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

const EMBED_KEY = 'sk-p0-rerank-embed-0123456789';
const RERANK_KEY = 'sk-p0-rerank-key-0123456789abcdef';
let srv, fake, user, book;

async function uploadBook(token, title, content) {
    const form = new FormData();
    form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
    const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()).book;
}

async function agentSearch(question) {
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: question } }] });
    const stream = await postSSE(srv.url, '/api/ask-stream', {
        token: user.token, body: { requestId: crypto.randomUUID(), question, bookId: book.id, provider: 'fakeprov' }
    });
    const ev = stream.events.find(e => e.type === 'evidence');
    const tr = stream.events.find(e => e.type === 'tool_result' && e.data.name === 'searchInBook');
    return { evidence: ev ? ev.data.items : [], toolResult: tr ? tr.data : null, events: stream.events };
}

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p0-rerank');
    const prov = await api(srv.url, '/api/providers', {
        method: 'POST', token: user.token,
        body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-rerank-chat-0123456789' }
    });
    assert.strictEqual(prov.status, 200, prov.text);
    book = await uploadBook(user.token, '测试书A', BOOK_A);
});

after(async () => {
    if (srv) await srv.stop();
    if (fake) await fake.close();
});

test('ER-01 自定义Embedding端点建库为 embedding+bm25', async () => {
    const res = await api(srv.url, '/api/embedding-settings', {
        method: 'PUT', token: user.token,
        body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed', customApiKey: EMBED_KEY }
    });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.data.active.providerId, 'custom');
    const idx = await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });
    assert.strictEqual(idx.data.mode, 'embedding+bm25');
    const status = await api(srv.url, `/api/books/${book.id}/index-status`, { token: user.token });
    assert.strictEqual(status.data.embedProvider, 'custom');
});

test('ER-02 启用重排后检索来源含 +rerank', async () => {
    const res = await api(srv.url, '/api/rerank-settings', {
        method: 'PUT', token: user.token,
        body: { enabled: true, baseUrl: `${fake.url}/v1/rerank`, model: 'fake-rerank', topN: 5, rerankApiKey: RERANK_KEY }
    });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(res.data.active, '重排应生效');
    const { evidence } = await agentSearch('青色灯塔的守塔人是谁');
    assert.ok(evidence.some(e => /rerank/.test(e.method)), `证据方法应含rerank: ${evidence.map(e => e.method)}`);
    assert.ok(evidence.length > 0);
});

test('ER-03 重排失败保留融合结果并给出warning', async () => {
    await fake.control({ rerankError: { status: 500, body: { error: { message: 'fake rerank outage' } } } });
    const { evidence, toolResult } = await agentSearch('青色灯塔的守塔人是谁');
    assert.ok(!evidence.some(e => /rerank/.test(e.method)), '重排失败不应标rerank');
    assert.ok(evidence.length > 0, '重排失败仍应返回融合结果');
    assert.ok(toolResult && toolResult.status === 'ok', '检索仍成功');
    await fake.control({ rerankError: null });
});

test('ER-04 关闭重排后检索不调用重排（消融条件）', async () => {
    await api(srv.url, '/api/rerank-settings', { method: 'PUT', token: user.token, body: { enabled: false } });
    const { evidence } = await agentSearch('青色灯塔的守塔人是谁');
    assert.ok(!evidence.some(e => /rerank/.test(e.method)), '关闭后不应含rerank');
    assert.ok(evidence.some(e => e.method === 'hybrid'), `应为hybrid: ${evidence.map(e => e.method)}`);
});

test('ER-05 重排配置按用户隔离且Key不入日志', async () => {
    const other = await registerUser(srv.url, 'p0-rerank-bob');
    const cfg = await api(srv.url, '/api/rerank-settings', { token: other.token });
    assert.strictEqual(cfg.data.enabled, false, '其他用户重排默认关闭');
    assert.strictEqual(cfg.data.hasKey, false, '其他用户无重排密钥');
    const logText = srv.logText();
    assert.ok(!logText.includes(RERANK_KEY), '日志不应泄漏重排Key');
    assert.ok(!logText.includes(EMBED_KEY), '日志不应泄漏Embedding Key');
});

test('rerankDocuments 纯函数：按相关性降序返回索引', async () => {
    const rerank = require('../rerank');
    const reranker = { endpoint: `${fake.url}/v1/rerank`, model: 'fake-rerank', apiKey: RERANK_KEY, topN: 3 };
    const docs = ['完全无关的内容xyz', '青色灯塔守塔人老周', '灯塔'];
    const ranked = await rerank.rerankDocuments(reranker, '青色灯塔守塔人', docs, { topN: 3 });
    assert.strictEqual(ranked.length, 3);
    assert.ok(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score, '应按分数降序');
    assert.strictEqual(ranked[ranked.length - 1].index, 0, '完全无关文档应排末位');
    assert.ok(ranked.every(r => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length), '索引合法');
});