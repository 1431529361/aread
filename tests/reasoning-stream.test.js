/**
 * 流式思考与正文分离测试（隔离临时库 + 本地假模型，不联网）：
 * R-T01 思考独立事件且不入正文、metadata.reasoning 持久化；
 * R-T02 工具打断时暂定正文收回（answer_retract）归入思考；
 * R-T03 直答路由真流式（delivery=stream，逐 chunk 下发）。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

const rid = () => crypto.randomUUID();
let srv, fake, user, book;

const ask = (body) => postSSE(srv.url, '/api/ask-stream', { token: user.token, body: { requestId: rid(), provider: 'fakeprov', ...body } });
const join = (events, type, field = 'content') => events.filter(e => e.type === type).map(e => e.data[field] || '').join('');

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'reason-alice');
    const p = await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'F', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-reason-0123456789abcdef' } });
    assert.strictEqual(p.status, 200, p.text);
    const form = new FormData();
    form.append('book', new Blob([BOOK_A], { type: 'text/plain' }), '书A.txt');
    const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    book = (await up.json()).book;
});
after(async () => { if (srv) await srv.stop(); if (fake) await fake.close(); });

test('R-T01 思考与正文分离：reasoning_chunk 独立、正文干净、metadata.reasoning 持久化', async () => {
    await fake.reset();
    await fake.control({ reasoning: 'THINK-ABC-思考过程', streamChunks: ['ANSWER-', 'ONE'] });
    const stream = await ask({ question: '你好', bookId: book.id, selection: { text: '海边有一座青色灯塔' } });
    assert.strictEqual(stream.events.find(e => e.type === 'end').data.status, 'completed');
    assert.ok(join(stream.events, 'reasoning_chunk').includes('THINK-ABC'), '应有独立思考试件');
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.assistantMessage.content, 'ANSWER-ONE', '正文不含思考');
    assert.ok(String(end.data.assistantMessage.metadata.reasoning).includes('THINK-ABC'), '思考持久化');
    const convId = stream.events.find(e => e.type === 'start').data.conversationId;
    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    const am = msgs.data.messages.find(m => m.id === end.data.assistantMessage.id);
    assert.ok(String(am.metadata.reasoning).includes('THINK-ABC'), '历史回读含思考');
});

test('R-T02 工具打断：暂定正文 answer_retract 收回，最终正文不含草稿', async () => {
    await fake.reset();
    await fake.control({
        reasoning: 'R2-思考',
        streamChunks: [],
        toolScript: [{ name: 'searchInBook', args: { query: '灯塔' }, thought: 'DRAFT-TEXT' }],
        finalAfterTools: 'FINAL-EVIDENCE'
    });
    const stream = await ask({ question: '守塔人是谁', bookId: book.id, selection: { text: '海边有一座青色灯塔' } });
    const types = stream.events.map(e => e.type);
    assert.ok(types.includes('chunk'), '决策轮暂定正文应直播');
    assert.ok(join(stream.events, 'chunk').includes('DRAFT-TEXT'));
    assert.ok(types.includes('answer_retract'), '工具打断应收回');
    assert.ok(types.indexOf('answer_retract') > types.indexOf('chunk'));
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.status, 'completed');
    assert.ok(end.data.assistantMessage.content.includes('FINAL-EVIDENCE'));
    assert.ok(!end.data.assistantMessage.content.includes('DRAFT-TEXT'), '终态正文不含被收回草稿');
    assert.ok(String(end.data.assistantMessage.metadata.reasoning).includes('R2-思考'));
});

test('R-T03 直答路由真流式：delivery=stream 且逐 chunk 下发', async () => {
    await fake.reset();
    await fake.control({ streamChunks: ['翻译', '结果'] });
    const stream = await ask({ question: '解释这段话', bookId: book.id, selection: { text: '海边有一座青色灯塔' }, action: 'explain' });
    const start = stream.events.find(e => e.type === 'answer_start');
    assert.strictEqual(start.data.delivery, 'stream');
    const chunks = stream.events.filter(e => e.type === 'chunk');
    assert.ok(chunks.length >= 2, '应逐增量下发');
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.assistantMessage.content, '翻译结果');
});
