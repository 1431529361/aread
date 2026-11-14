/**
 * P1a 验收确定性测试（A-T01~08）：权限/幂等/工具JSON/门控/持久化一次/长任务/请求查询。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

const rid = () => crypto.randomUUID();
let srv, fake, user, userB, book, bookB;

const ask = (body, token = user.token) => postSSE(srv.url, '/api/ask-stream', { token, body: { requestId: rid(), provider: 'fakeprov', ...body } });

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p1a-alice');
    userB = await registerUser(srv.url, 'p1a-bob');
    for (const u of [user, userB]) {
        const p = await api(srv.url, '/api/providers', { method: 'POST', token: u.token, body: { id: 'fakeprov', name: 'F', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p1a-0123456789abcdef' } });
        assert.strictEqual(p.status, 200, p.text);
    }
    const upload = async (token, title, content) => {
        const form = new FormData();
        form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
        return (await res.json()).book;
    };
    book = await upload(user.token, '书A', BOOK_A);
    bookB = await upload(userB.token, '书B', BOOK_A);
});
after(async () => { if (srv) await srv.stop(); if (fake) await fake.close(); });

test('A-T01 他人书籍返回404，不进入工具', async () => {
    await fake.reset();
    const res = await api(srv.url, '/api/ask-stream', { method: 'POST', token: user.token, body: { requestId: rid(), question: '守塔人', bookId: bookB.id, provider: 'fakeprov' } });
    assert.strictEqual(res.status, 404);
});

test('A-T01 会话与书籍不匹配返回409', async () => {
    const c = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: book.id } });
    const convId = c.data.conversation.id;
    const res = await api(srv.url, '/api/ask-stream', { method: 'POST', token: user.token, body: { requestId: rid(), question: 'q', bookId: bookB.id, conversationId: convId, provider: 'fakeprov' } });
    // bookB 属于 userB，先 404；用本人另一书验证 mismatch
    const book2 = await (async () => { const form = new FormData(); form.append('book', new Blob(['另一本书内容'], { type: 'text/plain' }), 'b2.txt'); const r = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form }); return (await r.json()).book; })();
    const res2 = await api(srv.url, '/api/ask-stream', { method: 'POST', token: user.token, body: { requestId: rid(), question: 'q', bookId: book2.id, conversationId: convId, provider: 'fakeprov' } });
    assert.strictEqual(res2.status, 409);
    assert.strictEqual(res2.data.error.code, 'CONVERSATION_BOOK_MISMATCH');
});

test('A-T02 同requestId重放不重复落库；异指纹冲突', async () => {
    await fake.reset();
    const requestId = rid();
    const body = { requestId, question: '幂等问题', bookId: book.id, provider: 'fakeprov' };
    const s1 = await postSSE(srv.url, '/api/ask-stream', { token: user.token, body });
    const convId = s1.events.find(e => e.type === 'start').data.conversationId;
    const s2 = await postSSE(srv.url, '/api/ask-stream', { token: user.token, body });
    const start2 = s2.events.find(e => e.type === 'start');
    assert.strictEqual(start2.data.replayed, true, '第二次应重放');
    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    assert.strictEqual(msgs.data.messages.filter(m => m.role === 'user').length, 1, '重放不重复落库');
    assert.strictEqual(msgs.data.messages.filter(m => m.role === 'assistant').length, 1);
    // 异指纹
    const s3 = await postSSE(srv.url, '/api/ask-stream', { token: user.token, body: { ...body, question: '不同的问题' } });
    assert.strictEqual(s3.status, 409);
    assert.strictEqual(s3.json.error.code, 'REQUEST_CONFLICT');
});

test('A-T03 不完整工具JSON不执行，返回结构化错误', async () => {
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', rawArguments: '{"query": 不完整' }] });
    const stream = await ask({ question: '守塔人', bookId: book.id });
    const tr = stream.events.find(e => e.type === 'tool_result');
    assert.ok(tr, '应有工具结果事件');
    assert.strictEqual(tr.data.status, 'error');
    assert.strictEqual(tr.data.error.code, 'INVALID_TOOL_ARGS');
    const ev = stream.events.find(e => e.type === 'evidence');
    assert.ok(ev && ev.data.items.length === 0, '非法参数不应产生证据');
});

test('A-T05 选文足够（explain）不强制检索', async () => {
    await fake.reset();
    const stream = await ask({ question: '解释这段话', bookId: book.id, selection: { text: '海边有一座青色灯塔' }, action: 'explain' });
    assert.ok(!stream.events.some(e => e.type === 'tool_call'), '选文解释不应强制检索');
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.status, 'completed');
});

test('A-T06 需取证但无证据→缺证说明，不冒充原文', async () => {
    await fake.reset();
    // 无索引、无工具调用 → 服务端补查也无命中 → insufficient_evidence
    const stream = await ask({ question: '书中某个不存在的事实', bookId: book.id });
    const as = stream.events.find(e => e.type === 'answer_start');
    assert.strictEqual(as.data.answerKind, 'insufficient_evidence');
    const end = stream.events.find(e => e.type === 'end');
    assert.ok(end.data.assistantMessage.content.includes('证据'), '应明确缺证');
});

test('A-T07 end在持久化后且仅一次；请求查询可恢复', async () => {
    await fake.reset();
    const requestId = rid();
    const stream = await ask({ question: '持久化验证', bookId: book.id, requestId });
    const ends = stream.events.filter(e => e.type === 'end');
    assert.strictEqual(ends.length, 1, 'end仅一次');
    const end = ends[0];
    assert.strictEqual(end.data.status, 'completed');
    const q = await api(srv.url, `/api/ask-requests/${requestId}`, { token: user.token });
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.data.status, 'completed');
    assert.strictEqual(q.data.assistantMessage.content, end.data.assistantMessage.content, '查询结果与end一致');
});

test('A-T08 长任务路由返回task_result与采样覆盖', async () => {
    await fake.reset();
    const stream = await ask({ question: '生成读书笔记', bookId: book.id, taskType: 'generate-notes' });
    const as = stream.events.find(e => e.type === 'answer_start');
    assert.strictEqual(as.data.answerKind, 'task_result');
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.status, 'completed');
    assert.strictEqual(end.data.assistantMessage.metadata.task.coverage.mode, 'sampled', '应标采样而非全书');
});

test('A-T02 缺失requestId返回400', async () => {
    const res = await api(srv.url, '/api/ask-stream', { method: 'POST', token: user.token, body: { question: 'q', provider: 'fakeprov' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.error.code, 'INVALID_REQUEST');
});