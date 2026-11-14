/**
 * 统一问答链路离线回归（P1a 新契约：/api/ask-stream + SSE 封套）。
 * 覆盖：流式事件、消息落库一次、自动工具循环、不支持工具降级、无Key、未登录、断流有界结束。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

const rid = () => crypto.randomUUID();
let srv, fake, user, book;

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p0-conv');
    const prov = await api(srv.url, '/api/providers', {
        method: 'POST', token: user.token,
        body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-conv-0123456789abcdef' }
    });
    assert.strictEqual(prov.status, 200, prov.text);
    const form = new FormData();
    form.append('book', new Blob([BOOK_A], { type: 'text/plain' }), '测试书A.txt');
    const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    book = (await up.json()).book;
});

after(async () => {
    if (srv) await srv.stop();
    if (fake) await fake.close();
});

const ask = (body) => postSSE(srv.url, '/api/ask-stream', { token: user.token, body: { requestId: rid(), provider: 'fakeprov', ...body } });

test('直答：start/chunk/end 封套齐全，消息落库一次', async () => {
    await fake.reset();
    const stream = await ask({ question: '第一段问题', bookId: book.id });
    assert.strictEqual(stream.status, 200);
    const types = stream.events.map(e => e.type);
    assert.ok(types.includes('start'));
    assert.ok(types.includes('answer_start'));
    assert.ok(types.includes('chunk'));
    assert.ok(types.includes('end'));
    const start = stream.events.find(e => e.type === 'start');
    assert.strictEqual(start.data.schemaVersion, 1);
    const convId = start.data.conversationId;
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.status, 'completed');

    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    assert.strictEqual(msgs.data.messages.filter(m => m.role === 'user').length, 1);
    assert.strictEqual(msgs.data.messages.filter(m => m.role === 'assistant').length, 1);
});

test('自动工具循环：tool_call/tool_result/evidence/end，答案落库一次', async () => {
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: '灯塔' } }] });
    const newConv = await api(srv.url, '/api/conversations', { method: 'POST', token: user.token, body: { bookId: book.id } });
    const convId = newConv.data.conversation.id;
    const stream = await ask({ question: '守塔人是谁', bookId: book.id, conversationId: convId });
    assert.strictEqual(stream.status, 200);
    const types = stream.events.map(e => e.type);
    assert.ok(types.includes('tool_call'), '应有工具调用');
    assert.ok(types.includes('tool_result'), '应有工具结果');
    assert.ok(types.includes('evidence'), '应有证据登记');
    assert.ok(types.includes('end'));
    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    assert.strictEqual(msgs.data.messages.filter(m => m.role === 'assistant').length, 1, '最终答案只落库一次');
});

test('模型不支持工具（400）时降级并正常结束', async () => {
    await fake.reset();
    await fake.control({ toolHttpError: { status: 400, body: { error: { message: 'tools not supported' } } } });
    const stream = await ask({ question: '你好', bookId: book.id });
    assert.strictEqual(stream.status, 200);
    assert.ok(stream.events.some(e => e.type === 'warning'), '应有降级warning');
    const end = stream.events.find(e => e.type === 'end');
    assert.ok(end && end.data.status === 'completed', '降级后仍正常结束');
});

test('无Key用户返回403（不绕过鉴权）', async () => {
    const fresh = await registerUser(srv.url, 'p0-nokey');
    const res = await api(srv.url, '/api/ask-stream', { method: 'POST', token: fresh.token, body: { requestId: rid(), question: '你好', provider: 'zhipu' } });
    assert.strictEqual(res.status, 403);
});

test('未登录请求被拒绝', async () => {
    const res = await api(srv.url, '/api/books');
    assert.strictEqual(res.status, 401);
});

test('断流场景：上游中途断开时有界结束并标中断（不永久挂起）', async () => {
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: '灯塔' } }], cutStreamAfter: 1 });
    const stream = await postSSE(srv.url, '/api/ask-stream', {
        token: user.token, body: { requestId: rid(), question: '断流测试', bookId: book.id, provider: 'fakeprov' }, timeoutMs: 15000
    });
    const end = stream.events.find(e => e.type === 'end');
    assert.ok(end, '断流后应有终态end');
    assert.ok(['interrupted', 'failed', 'cancelled'].includes(end.data.status), `应标中断/失败: ${end.data.status}`);
});