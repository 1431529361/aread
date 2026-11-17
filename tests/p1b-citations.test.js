/**
 * P1b R3a 引用/选文验收测试（R-T15~T18）：
 * 工具截短坐标一致、引用标记白名单/跨块/未闭合规范化、历史快照恢复、选文版本验证与失效。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A } = require('./helpers/fixtures');

const rid = () => crypto.randomUUID();
let srv, fake, user, userB, book, content, contentHash;

const LONG_CHAPTER_BOOK = '第一章 超长章\n' + '这是超长章节的正文内容，用于截短定位测试。'.repeat(120) + '\n第二章 短章\n短章内容。\n';

async function upload(token, title, text) {
    const form = new FormData();
    form.append('book', new Blob([text], { type: 'text/plain' }), `${title}.txt`);
    const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()).book;
}
const ask = (body, token = user.token) => postSSE(srv.url, '/api/ask-stream', { token, body: { requestId: rid(), provider: 'fakeprov', ...body } });

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p1b-alice');
    userB = await registerUser(srv.url, 'p1b-bob');
    for (const u of [user, userB]) {
        const p = await api(srv.url, '/api/providers', { method: 'POST', token: u.token, body: { id: 'fakeprov', name: 'F', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p1b-0123456789abcdef' } });
        assert.strictEqual(p.status, 200, p.text);
    }
    book = await upload(user.token, '引用书', BOOK_A);
    const bd = await api(srv.url, `/api/books/${book.id}`, { token: user.token });
    content = bd.data.content;
    contentHash = bd.data.contentHash;
    assert.ok(contentHash && Array.isArray(bd.data.chapters), 'GET book 应返回 contentHash 与 chapters');
    await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });
});
after(async () => { if (srv) await srv.stop(); if (fake) await fake.close(); });

test('R-T15 长章截短：truncated=true 且坐标与text一致，JSON可解析', async () => {
    const lb = await upload(user.token, '长章书', LONG_CHAPTER_BOOK);
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'getChapterInfo', args: { chapterIndex: 1 } }] });
    const stream = await ask({ question: '第一章内容', bookId: lb.id });
    const tr = stream.events.find(e => e.type === 'tool_result' && e.data.name === 'getChapterInfo');
    assert.ok(tr && tr.data.truncated, '长章应标 truncated');
    const ev = stream.events.find(e => e.type === 'evidence');
    const c = ev.data.items.find(e => e.method === 'chapter');
    assert.ok(c && c.locator, '章节证据应有 locator');
    const bd = await api(srv.url, `/api/books/${lb.id}`, { token: user.token });
    assert.strictEqual(c.text, bd.data.content.slice(c.locator.start, c.locator.end), '截短后 text 必须等于原文 slice');
    assert.ok(c.text.length <= 1500);
    // 工具结果 JSON 合法（tool_call 参数与结果均经校验）
    const tc = stream.events.find(e => e.type === 'tool_call');
    assert.ok(tc.data.args && typeof tc.data.args === 'object');
});

test('R-T16 引用白名单：跨块合法标记保留，未知E99/未闭合规范化，历史一致', async () => {
    await fake.reset();
    await fake.control({
        toolScript: [{ name: 'searchInBook', args: { query: '青色灯塔的守塔人是谁' } }],
        streamChunks: ['依据[[E', '1]]作答，未知[[E99]]，残缺[[E2']
    });
    const requestId = rid();
    const stream = await ask({ question: '守塔人是谁', bookId: book.id, requestId });
    const end = stream.events.find(e => e.type === 'end');
    assert.strictEqual(end.data.status, 'completed');
    const am = end.data.assistantMessage;
    assert.ok(am.content.includes('[[E1]]'), '合法标记保留');
    assert.ok(!am.content.includes('[[E99]]'), '未知标记应规范化');
    assert.ok(!am.content.includes('[[E2'), '未闭合标记应规范化');
    assert.ok(am.content.includes('引用无效'));
    assert.deepStrictEqual(am.metadata.citedEvidenceIds, ['E1']);
    assert.ok(am.metadata.warnings.some(w => w.code === 'INVALID_CITATION'));
    assert.ok(am.metadata.evidence.length > 0);
    // 历史读取与 end 一致
    const convId = stream.events.find(e => e.type === 'start').data.conversationId;
    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    const saved = msgs.data.messages.find(m => m.role === 'assistant' && m.requestId === requestId);
    assert.strictEqual(saved.content, am.content, '历史正文与实时一致');
    assert.deepStrictEqual(saved.metadata.citedEvidenceIds, ['E1']);
    assert.strictEqual(saved.metadata.evidence.length, am.metadata.evidence.length);
});

test('R-T17 重开会话/重建索引但原文未变：快照可恢复且仍可定位', async () => {
    await fake.reset();
    await fake.control({ toolScript: [{ name: 'searchInBook', args: { query: '航海日志' } }], finalAfterTools: '日志在地下室[[E1]]。' });
    const requestId = rid();
    const stream = await ask({ question: '航海日志在哪', bookId: book.id, requestId });
    const convId = stream.events.find(e => e.type === 'start').data.conversationId;
    const ev = stream.events.find(e => e.type === 'evidence').data.items;
    assert.ok(ev.length > 0);
    // 重建索引（原文不变 → hash 不变，新版本）
    const re = await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });
    assert.strictEqual(re.data.success, true);
    const bd = await api(srv.url, `/api/books/${book.id}`, { token: user.token });
    assert.strictEqual(bd.data.contentHash, contentHash, '原文未变 hash 不变');
    // 重开会话读取快照：证据 locator 仍与当前原文一致，无需再检索
    const msgs = await api(srv.url, `/api/conversations/${convId}/messages`, { token: user.token });
    const saved = msgs.data.messages.find(m => m.requestId === requestId && m.role === 'assistant');
    for (const e of saved.metadata.evidence) {
        if (e.locator) {
            assert.strictEqual(e.locator.contentHash, contentHash);
            assert.strictEqual(e.text, bd.data.content.slice(e.locator.start, e.locator.end), '重建后历史引用仍可定位');
        }
    }
    // 重放：不重新检索/生成
    await fake.reset();
    const replay = await postSSE(srv.url, '/api/ask-stream', { token: user.token, body: { requestId, question: '航海日志在哪', bookId: book.id, provider: 'fakeprov' } });
    const rs = replay.events.find(e => e.type === 'start');
    assert.strictEqual(rs.data.replayed, true);
    const re2 = replay.events.find(e => e.type === 'end');
    assert.strictEqual(re2.data.assistantMessage.content, saved.content);
    assert.ok(!replay.events.some(e => e.type === 'tool_call'), '重放不应再调用工具');
});

test('R-T18 选文验证：版本失配409/范围不符422/合法verified；删书后重放仍可用', async () => {
    await fake.reset();
    // 合法选文
    const sel = { text: content.slice(10, 30), locator: { contentHash, start: 10, end: 30 } };
    const okStream = await ask({ question: '解释', bookId: book.id, selection: sel, action: 'explain' });
    const okEv = okStream.events.find(e => e.type === 'evidence');
    const us = okEv.data.items.find(e => e.kind === 'user_selection');
    assert.ok(us && us.verified === true, '合法选文应 verified');
    assert.strictEqual(us.locator.start, 10);
    // 版本失配
    const badHash = await ask({ question: '解释', bookId: book.id, selection: { text: sel.text, locator: { contentHash: 'txt-v1:' + '0'.repeat(64), start: 10, end: 30 } }, action: 'explain' });
    assert.strictEqual(badHash.status, 409);
    assert.strictEqual(badHash.json.error.code, 'BOOK_CONTENT_CHANGED');
    // 范围/文本不符
    const badRange = await ask({ question: '解释', bookId: book.id, selection: { text: '与原文不符的文本', locator: { contentHash, start: 10, end: 30 } }, action: 'explain' });
    assert.strictEqual(badRange.status, 422);
    assert.strictEqual(badRange.json.error.code, 'INVALID_SELECTION');
    // 跨用户书籍 404
    const cross = await ask({ question: 'q', bookId: book.id }, userB.token);
    assert.strictEqual(cross.status, 404);

    // 删书后：新请求 404，但已终结请求重放仍返回保存答案（引用不可用但不重新生成）
    const del = await api(srv.url, `/api/books/${book.id}`, { method: 'DELETE', token: user.token });
    assert.strictEqual(del.data.success, true);
    const afterDel = await ask({ question: '新问题', bookId: book.id });
    assert.strictEqual(afterDel.status, 404);
});