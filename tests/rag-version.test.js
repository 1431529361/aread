/**
 * P1b R2 API 级版本测试（隔离服务 + 假模型）：
 * R-T08 同书互斥409、R-T09 取消、R-T11 迟到批次/发布前改正文、R-T12 指纹不兼容降级。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

let srv, fake, user, book;
const EMBED_KEY = 'sk-r2-api-embed-0123456789';

// 多批次长书（>20 块），便于在构建中途注入操作
const LONG_BOOK = (() => {
    let s = '';
    for (let c = 1; c <= 6; c++) {
        s += `第${'一二三四五六'[c - 1]}章 测试章\n`;
        for (let p = 0; p < 8; p++) s += `这是第${c}章的第${p}段内容，包含独特标记词${c}${p}。`.repeat(6) + '\n\n';
    }
    return s;
})();

async function upload(title, content) {
    const form = new FormData();
    form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
    const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    return (await res.json()).book;
}
const indexPost = (bookId, body = {}) => api(srv.url, `/api/books/${bookId}/index`, { method: 'POST', token: user.token, body });
const status = (bookId) => api(srv.url, `/api/books/${bookId}/index-status`, { token: user.token });

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'r2-api');
    const prov = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'F', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-r2-api-chat-0123456789' } });
    assert.strictEqual(prov.status, 200, prov.text);
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed', customApiKey: EMBED_KEY } });
    book = await upload('短书', BOOK_A);
});
after(async () => { if (srv) await srv.stop(); if (fake) await fake.close(); });

test('R-T08 同书双重建：仅一个 building，另一个 409，旧 active 仍可查', async () => {
    const b = await upload('长书互斥', LONG_BOOK);
    const first = await indexPost(b.id); // 先建一个 active
    assert.strictEqual(first.data.success, true);
    await fake.control({ latencyMs: 400 });
    const p1 = indexPost(b.id); // 重建（慢）
    await new Promise(r => setTimeout(r, 200));
    const second = await indexPost(b.id);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.data.error.code, 'INDEX_BUILD_RUNNING');
    // 旧 active 仍可查
    const st = await status(b.id);
    assert.strictEqual(st.data.usable, true);
    assert.strictEqual(st.data.build.state, 'building');
    const r1 = await p1;
    assert.strictEqual(r1.data.success, true);
    await fake.control({ latencyMs: 0 });
    // 其他书不互斥
    const other = await upload('另一书', BOOK_A);
    const ro = await indexPost(other.id);
    assert.strictEqual(ro.data.success, true);
});

test('R-T09 构建取消：未发布版本不可见，不自动续跑', async () => {
    const b = await upload('取消书', LONG_BOOK);
    await fake.control({ latencyMs: 500 });
    const ac = new AbortController();
    const p = fetch(`${srv.url}/api/books/${b.id}/index`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` }, body: '{}', signal: ac.signal });
    setTimeout(() => ac.abort(), 250);
    await assert.rejects(p, e => e.name === 'AbortError');
    await new Promise(r => setTimeout(r, 600)); // 等服务端处理取消
    const st = await status(b.id);
    assert.strictEqual(st.data.usable, false, '取消后无可用 active');
    assert.ok(!st.data.build || st.data.build.state !== 'building', '不应遗留 building');
    await fake.control({ latencyMs: 0 });
});

test('R-T11 删书后迟到批次不写孤儿向量；发布前改正文不发布', async () => {
    // 场景一：构建中途删书
    const b = await upload('删书批次', LONG_BOOK);
    await fake.control({ latencyMs: 500 });
    const p = indexPost(b.id);
    await new Promise(r => setTimeout(r, 250));
    const del = await api(srv.url, `/api/books/${b.id}`, { method: 'DELETE', token: user.token });
    assert.strictEqual(del.data.success, true);
    const r = await p;
    assert.ok([499, 500].includes(r.status), `删书后构建应失败/取消（实际 ${r.status}）`);
    await fake.control({ latencyMs: 0 });
    // 无孤儿向量（该书块已删）
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const raw = new Database(path.join(srv.dataRoot, 'data.db'), { readonly: true });
    try {
        sqliteVec.load(raw);
        const orphans = raw.prepare('SELECT COUNT(*) c FROM rag_vec WHERE rowid NOT IN (SELECT id FROM rag_chunks)').get().c;
        assert.strictEqual(orphans, 0);
    } finally {
        raw.close();
    }

    // 场景二：构建中途改正文 → 发布前 hash 复核失败，不发布
    const b2 = await upload('改正文书', LONG_BOOK);
    await fake.control({ latencyMs: 500 });
    const p2 = indexPost(b2.id);
    await new Promise(r => setTimeout(r, 250));
    const filePath = path.join(srv.dataRoot, 'books', user.userId, b2.filename);
    fs.writeFileSync(filePath, '完全不同的新正文内容。\n'.repeat(50), 'utf-8');
    const r2 = await p2;
    assert.ok(r2.status === 500 || r2.data.success === false, '正文变化不应发布');
    if (r2.status === 500) assert.strictEqual(r2.data.error.code, 'CONTENT_CHANGED');
    const st2 = await status(b2.id);
    assert.strictEqual(st2.data.usable, false);
    await fake.control({ latencyMs: 0 });
});

test('R-T12 端点变更但模型同名：向量不兼容降级 BM25 且有原因', async () => {
    const b = await upload('指纹书', BOOK_A);
    const r = await indexPost(b.id);
    assert.strictEqual(r.data.active.mode, 'embedding+bm25');
    // 改端点（/v1 → /v2），模型名不变
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v2`, customModel: 'fake-embed' } });
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: '青色灯塔的守塔人是谁' } }] });
    const stream = await postSSE(srv.url, '/api/ask-stream', { token: user.token, body: { requestId: crypto.randomUUID(), question: '青色灯塔的守塔人是谁', bookId: b.id, provider: 'fakeprov' } });
    const ev = stream.events.find(e => e.type === 'evidence');
    const tr = stream.events.find(e => e.type === 'tool_result' && e.data.name === 'searchInBook');
    assert.ok(ev && ev.data.items.length > 0, 'BM25 仍应命中');
    assert.ok(ev.data.items.every(e => e.method === 'bm25'), `不兼容时只用 BM25: ${ev.data.items.map(e => e.method)}`);
    assert.strictEqual(tr.data.source, 'bm25');
    // 恢复端点
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed' } });
});