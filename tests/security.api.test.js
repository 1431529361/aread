/**
 * P0-03 密钥日志泄漏检查 + P0-04 记忆 kind 安全校验（API 级）。
 * 使用人工测试 Key，验证成功/失败路径日志均不含 Key 全文或前缀；
 * 模型返回的非法 kind 被安全降级，不进入存储的任意类型。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { startIsolatedServer, api, registerUser, postSSE, waitFor } = require('./helpers/isolated-server');
const { startFakeModelServer } = require('./helpers/fake-model-server');
const { MALICIOUS_EXTRACTION } = require('./helpers/fixtures');

const TEST_KEY = 'sk-p0-test-0123456789abcdef-KEY';
let srv, fake, user, providerId;

before(async () => {
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    user = await registerUser(srv.url, 'p0-sec');
    // 自定义提供商指向本地假模型
    const res = await api(srv.url, '/api/providers', {
        method: 'POST',
        token: user.token,
        body: {
            name: 'FakeLocal',
            apiEndpoint: `${fake.url}/v1`,
            defaultModel: 'fake-model',
            apiKey: TEST_KEY
        }
    });
    assert.strictEqual(res.status, 200, `创建提供商失败: ${res.text}`);
    providerId = res.data.provider.id;
});

after(async () => {
    if (srv) await srv.stop();
    if (fake) await fake.close();
});

function assertNoKeyLeak(logText, label) {
    assert.ok(!logText.includes(TEST_KEY), `${label}: 日志泄漏完整测试Key`);
    assert.ok(!logText.includes(TEST_KEY.substring(0, 10)), `${label}: 日志泄漏Key前缀`);
    assert.ok(!logText.includes(TEST_KEY.substring(0, 8)), `${label}: 日志泄漏Key前8位（掩码前缀）`);
}

test('P0-03 成功路径：普通问答与流式问答日志不含Key', async () => {
    await fake.reset();
    const ask = await api(srv.url, '/api/ask', {
        method: 'POST', token: user.token,
        body: { text: '选中文本', question: '你好', provider: providerId }
    });
    assert.strictEqual(ask.status, 200, ask.text);

    const stream = await postSSE(srv.url, '/api/ask-stream', {
        token: user.token,
        body: { requestId: crypto.randomUUID(), question: '你好', provider: providerId }
    });
    assert.strictEqual(stream.status, 200);
    assert.ok(stream.events.some(e => e.type === 'end'), '流式应正常结束');

    assertNoKeyLeak(srv.logText(), '成功路径');
});

test('P0-03 失败路径：上游401回显Key时日志不泄漏', async () => {
    await fake.control({
        httpError: { status: 401, body: { error: { message: `Invalid API key provided: ${TEST_KEY}` } } }
    });
    const ask = await api(srv.url, '/api/ask', {
        method: 'POST', token: user.token,
        body: { text: '选中文本', question: '你好', provider: providerId }
    });
    assert.ok(ask.status === 401 || ask.status === 500, `应返回错误状态: ${ask.status}`);

    const stream = await postSSE(srv.url, '/api/ask-stream', {
        token: user.token,
        body: { requestId: crypto.randomUUID(), question: '你好', provider: providerId }
    });
    assert.ok(stream.status >= 400 || stream.events.some(e => e.type === 'end' && e.data.status !== 'completed'), '失败路径应有错误终态');

    assertNoKeyLeak(srv.logText(), '失败路径');
    await fake.control({ httpError: null });
});

test('P0-03 密钥校验失败路径日志不泄漏', async () => {
    await fake.control({
        httpError: { status: 403, body: { error: { message: `bad key ${TEST_KEY}` } } }
    });
    const res = await api(srv.url, '/api/key/set', {
        method: 'POST', token: user.token,
        body: { apiKey: TEST_KEY, provider: providerId }
    });
    assert.strictEqual(res.status, 400);
    assertNoKeyLeak(srv.logText(), '密钥校验失败');
    await fake.control({ httpError: null });
});

test('P0-04 非法记忆kind被拒绝写入（P2契约），合法kind保留且来源可溯', async () => {
    await fake.reset();
    await fake.control({ extraction: MALICIOUS_EXTRACTION });

    const requestId = crypto.randomUUID();
    const stream = await postSSE(srv.url, '/api/ask-stream', {
        token: user.token,
        body: { requestId, question: '请记住我的偏好', provider: providerId }
    });
    assert.ok(stream.events.some(e => e.type === 'end'));

    const memories = await waitFor(async () => {
        const res = await api(srv.url, '/api/memories', { token: user.token });
        return res.data.memories && res.data.memories.length >= 2 ? res.data.memories : null;
    });
    assert.ok(memories, '异步记忆抽取应入库');

    const allowed = new Set(['preference', 'fact', 'interest', 'reading_goal', 'open_question']);
    for (const m of memories) {
        assert.ok(allowed.has(m.kind), `非法kind未被拒绝: ${JSON.stringify(m.kind)}`);
    }
    assert.ok(memories.some(m => m.kind === 'preference' && m.content === '用户偏好分点回答' && m.status === 'active'));
    assert.ok(memories.some(m => m.kind === 'interest'), '合法interest应保留');
    // P2：非法 kind 不再降级入库，而是整条拒绝
    const contents = memories.map(m => m.content);
    assert.ok(!contents.includes('非法kind样本'), '非法kind候选不应写入');
    assert.ok(!contents.includes('大写kind样本'), '大写kind候选不应写入');
    assert.ok(!contents.includes('数字kind样本'), '数字kind候选不应写入');
    // 来源可溯：user_message + 原话范围
    const pref = memories.find(m => m.content === '用户偏好分点回答');
    assert.strictEqual(pref.source.type, 'user_message');
    assert.ok(Number.isInteger(pref.source.messageId));
    assert.deepStrictEqual(pref.source.range, { start: 0, end: 7 });
    // 后处理真实状态：completed + 真实 memoryChanges（2条合法）
    const req = await waitFor(async () => {
        const r = await api(srv.url, `/api/ask-requests/${requestId}`, { token: user.token });
        return r.data && r.data.postProcessing && r.data.postProcessing.status !== 'pending' ? r.data : null;
    });
    assert.strictEqual(req.postProcessing.status, 'completed');
    assert.strictEqual(req.postProcessing.memoryChanges.length, 2);
});

test('P0-04 记忆content中的HTML原样存储（前端负责安全渲染，浏览器用例验证）', async () => {
    const res = await api(srv.url, '/api/memories', { token: user.token });
    const htmlMem = res.data.memories.find(m => m.content.includes('<img'));
    assert.ok(htmlMem, '含HTML的记忆内容应存在');
    assert.ok(htmlMem.content.includes('onerror'), 'API层保留原文，转义在前端');
});