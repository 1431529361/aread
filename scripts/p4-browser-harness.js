/**
 * P4 浏览器回归 harness：隔离应用服务 + 本地假模型 + 合成测试书。
 * 固定演示流程12项：登录/上传/索引/阅读/问答/引用跳转/会话恢复/记忆纠正/删除/无索引/模型或Embedding失败/任务复用。
 * 书籍文件写到操作系统临时目录供浏览器上传；连接信息写 .p4-browser-harness.json。
 * 用法：node scripts/p4-browser-harness.js （保持存活；结束按 PID 精确终止）
 */
const fs = require('fs');
const os = require('os');
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

const TOOL_SCRIPT = [{ name: 'searchInBook', args: { query: '灯塔' }, thought: '需要查阅书中灯塔相关原文' }];
const FINAL_WITH_CITATION = '书中写道：海边有一座青色灯塔，守塔人叫老周。[[E1]]';
const EXTRACTION_CONCISE = JSON.stringify([
    { kind: 'preference', key: 'preference.answer_length', normalizedValue: 'concise', content: '用户偏好简洁的回答', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 8 }, statementType: 'explicit', stability: 'stable', relation: 'independent' }
]);
const EXTRACTION_DETAILED = JSON.stringify([
    { kind: 'preference', key: 'preference.answer_length', normalizedValue: 'detailed', content: '用户更正为偏好详细的回答', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 10 }, statementType: 'explicit', stability: 'stable', relation: 'independent' }
]);

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-p4-books-'));
    const fileA = path.join(dir, '灯塔测试书A.txt');
    const fileB = path.join(dir, '山村测试书B.txt');
    fs.writeFileSync(fileA, BOOK_A, 'utf-8');
    fs.writeFileSync(fileB, BOOK_B, 'utf-8');
    const fake = await startFakeModelServer();
    const srv = await startIsolatedServer();
    const username = 'p4-demo';
    const password = 'p4-demo-pass-123';
    const user = await registerUser(srv.url, username, password);
    await api(srv.url, '/api/providers', { method: 'POST', token: user.token, body: { id: 'fakeprov', name: 'FakeProv', apiEndpoint: `${fake.url}/v1`, defaultModel: 'fake-model', apiKey: 'sk-p4-browser-0123456789abcdef' } });
    await api(srv.url, '/api/embedding-settings', { method: 'PUT', token: user.token, body: { provider: 'custom', customBaseUrl: `${fake.url}/v1`, customModel: 'fake-embed', customApiKey: 'sk-p4-browser-embed-0123456789' } });
    await fake.control({
        toolScript: TOOL_SCRIPT,
        finalAfterTools: FINAL_WITH_CITATION,
        chatReply: '这是本地假模型的确定性回答。',
        streamChunks: [],
        extraction: EXTRACTION_CONCISE
    });
    const info = {
        appUrl: srv.url, fakeUrl: fake.url, fakeControl: `${fake.url}/__control`,
        username, password, userId: user.userId, token: user.token,
        fileA, fileB, dataRoot: srv.dataRoot,
        controls: { extractionConcise: EXTRACTION_CONCISE, extractionDetailed: EXTRACTION_DETAILED, toolScript: TOOL_SCRIPT, finalWithCitation: FINAL_WITH_CITATION }
    };
    fs.writeFileSync(path.join(__dirname, '..', '.p4-browser-harness.json'), JSON.stringify(info, null, 2));
    console.log('P4_BROWSER_HARNESS_READY');
    console.log(JSON.stringify(info, null, 2));
    setInterval(() => {}, 1 << 30);
}
main().catch(e => { console.error(e); process.exit(1); });