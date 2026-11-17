/**
 * P2 记忆治理浏览器验证 harness：隔离应用服务 + 本地假模型 + 两本测试书。
 * 仅用于浏览器验证，不触碰业务数据。运行后保持存活，连接信息写 .p2-browser-harness.json。
 * 用法：node scripts/p2-browser-harness.js
 * 通过假模型 /__control 切换 extraction 脚本（curl）。
 */
const fs = require('fs');
const path = require('path');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const { startFakeModelServer } = require('../tests/helpers/fake-model-server');

const BOOK_A = `第一章 启程
林远出生在北方的小城，父亲是一名钟表匠。他从小喜欢听钟表齿轮的声音。

第二章 灯塔
海边有一座青色灯塔，守塔人叫老周。灯塔每晚点亮，为渔船指引方向。
时间跳跃在这本书里频繁出现，读者需要留意年份变化。

第三章 秘密
林远在灯塔的地下室发现了一本蓝色封皮的航海日志，记录着三十年前的沉船事件。
`;

const BOOK_B = `第一章 山村
苏梅在山村里教孩子们读书，教室里只有一块黑板。
第二章 洪水
夏天洪水冲毁了木桥，苏梅带孩子们绕山路去上学。
`;

// 默认抽取：明确稳定的分点偏好（sourceMessageId 由假模型按 prompt 真实ID替换）
const DEFAULT_EXTRACTION = JSON.stringify([
    { kind: 'preference', key: 'preference.answer_format', normalizedValue: 'bullets', content: '用户偏好分点回答', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 4 }, statementType: 'explicit', stability: 'stable', relation: 'independent' }
]);

async function main() {
    const fake = await startFakeModelServer();
    const srv = await startIsolatedServer();
    const username = 'browser-test';
    const password = 'browser-test-pass-123';
    const user = await registerUser(srv.url, username, password);
    await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-browser-0123456789abcdef' } });
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed', customApiKey: 'sk-browser-embed-0123456789' } });
    const books = {};
    for (const [key, text, name] of [['A', BOOK_A, '记忆测试书A.txt'], ['B', BOOK_B, '记忆测试书B.txt']]) {
        const form = new FormData();
        form.append('book', new Blob([text], { type: 'text/plain' }), name);
        const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        const book = (await up.json()).book;
        await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });
        books[key] = book.id;
    }
    await fake.control({ extraction: DEFAULT_EXTRACTION, chatReply: '这是本地假模型的确定性回答。', streamChunks: ['这是', '本地假模型', '的确定性回答。'] });
    const info = {
        appUrl: srv.url,
        fakeUrl: fake.url,
        fakeControl: `${fake.url}/__control`,
        username, password,
        userId: user.userId,
        token: user.token,
        bookA: books.A,
        bookB: books.B,
        dataRoot: srv.dataRoot
    };
    fs.writeFileSync(path.join(__dirname, '..', '.p2-browser-harness.json'), JSON.stringify(info, null, 2));
    console.log('P2_BROWSER_HARNESS_READY');
    console.log(JSON.stringify(info, null, 2));
    setInterval(() => {}, 1 << 30);
}
main().catch(e => { console.error(e); process.exit(1); });