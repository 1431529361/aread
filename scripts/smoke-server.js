/**
 * 浏览器冒烟环境启动器（仅本地假模型，确定性、零费用）。
 * 启动隔离服务+假模型，预配置提供商/Embedding/测试书/记忆注入样本，
 * 打印连接信息并保持运行，供浏览器自动化走主流程。Ctrl+C 退出并清理。
 * 用法：node scripts/smoke-server.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startIsolatedServer, api, registerUser } = require('../tests/helpers/isolated-server');
const { startFakeModelServer } = require('../tests/helpers/fake-model-server');
const { BOOK_A, HTML_INJECTION_TEXT, MALICIOUS_EXTRACTION } = require('../tests/helpers/fixtures');

async function main() {
    const fake = await startFakeModelServer();
    await fake.control({
        extraction: MALICIOUS_EXTRACTION,
        toolScript: [{ name: 'searchInBook', args: { query: '青色灯塔 守塔人' } }],
        chatReply: '这是本地假模型为浏览器冒烟生成的确定性回答：守塔人是老周。',
        streamChunks: ['这是本地假模型', '为浏览器冒烟', '生成的确定性回答：', '守塔人是老周。']
    });
    const srv = await startIsolatedServer();
    const user = await registerUser(srv.url, 'smoke-user', 'smoke-pass-123');

    await api(srv.url, '/api/providers', {
        method: 'POST', token: user.token,
        body: { id: 'fakeprov', name: 'FakeLocal', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p0-smoke-0123456789abcdef' }
    });
    await api(srv.url, '/api/embedding-settings', {
        method: 'PUT', token: user.token,
        body: { provider: 'aliyun', aliyunBaseUrl: `${fake.url}/v1`, aliyunModel: 'fake-embed', aliyunApiKey: 'sk-p0-smoke-embed-0123456789' }
    });

    async function upload(title, content) {
        const form = new FormData();
        form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
        const res = await fetch(`${srv.url}/api/books/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
        return (await res.json()).book;
    }
    const book = await upload('冒烟测试书A', BOOK_A);
    const htmlBook = await upload('HTML注入样本', HTML_INJECTION_TEXT);
    await api(srv.url, `/api/books/${book.id}/index`, { method: 'POST', token: user.token, body: {} });

    const info = {
        url: srv.url,
        fakeUrl: fake.url,
        username: 'smoke-user',
        password: 'smoke-pass-123',
        bookId: book.id,
        htmlBookId: htmlBook.id,
        dataRoot: srv.dataRoot,
        note: '本地假模型冒烟环境，非真实模型；token为临时JWT'
    };
    const infoPath = path.join(os.tmpdir(), 'reader-p0-smoke.json');
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf-8');
    console.log('SMOKE_READY ' + JSON.stringify(info));
    console.log('连接信息文件: ' + infoPath);

    const cleanup = async () => { try { await srv.stop(); } catch {} try { await fake.close(); } catch {} process.exit(0); };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    setInterval(() => {}, 1 << 30);
}

main().catch(e => { console.error(e); process.exit(1); });