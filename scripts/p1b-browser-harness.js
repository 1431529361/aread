/**
 * P1b 浏览器验证 harness：启动隔离应用服务 + 本地假模型，注入富测试书与确定性引用回答。
 * 仅用于浏览器手工/自动验证，不触碰业务数据。运行后保持存活，打印连接信息。
 * 用法：node scripts/p1b-browser-harness.js
 * 通过假模型 /__control 可在验证过程中切换回答脚本（curl）。
 */
const fs = require('fs');
const path = require('path');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const { startFakeModelServer } = require('../tests/helpers/fake-model-server');

const TEST_BOOK = `第一章 启程
林远出生在北方的小城，父亲是一名钟表匠。他从小喜欢听钟表齿轮的声音。
这是一段重复的段落，用于定位测试。

第二章 灯塔
海边有一座青色灯塔，守塔人叫老周。灯塔每晚点亮，为渔船指引方向。
这是一段重复的段落，用于定位测试。
表情符号测试A😀B以及更多占位内容。

第三章 秘密
林远在灯塔的地下室发现了一本蓝色封皮的航海日志，记录着三十年前的沉船事件。
多年以后，林远回到小城，把航海日志交给了历史博物馆。
`;

async function main() {
    const fake = await startFakeModelServer();
    const srv = await startIsolatedServer();
    const username = 'browser-test';
    const password = 'browser-test-pass-123';
    const user = await registerUser(srv.url, username, password);
    await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-browser-0123456789abcdef' } });
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed', customApiKey: 'sk-browser-embed-0123456789' } });
    const form = new FormData();
    form.append('book', new Blob([TEST_BOOK], { type: 'text/plain' }), '定位测试书.txt');
    const up = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    const book = (await up.json()).book;
    const idx = await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });
    // 默认回答脚本：检索 + 含合法/未知/跨块引用
    await fake.control({
        toolScript: [{ name: 'searchInBook', args: { query: '青色灯塔的守塔人是谁' } }],
        finalAfterTools: '守塔人是老周[[E1]]。相关段落见[[E2]]。未知引用[[E99]]。',
        streamChunks: ['守塔人是老周[[E', '1]]。相关段落见[[E2]]。未知引用[[E99]]。']
    });
    const info = {
        appUrl: srv.url,
        fakeUrl: fake.url,
        fakeControl: `${fake.url}/__control`,
        username, password,
        userId: user.userId,
        token: user.token,
        bookId: book.id,
        indexMode: idx.data.active && idx.data.active.mode,
        dataRoot: srv.dataRoot
    };
    fs.writeFileSync(path.join(__dirname, '..', '.p1b-browser-harness.json'), JSON.stringify(info, null, 2));
    console.log('P1B_BROWSER_HARNESS_READY');
    console.log(JSON.stringify(info, null, 2));
    // 保持存活
    setInterval(() => {}, 1 << 30);
}
main().catch(e => { console.error(e); process.exit(1); });