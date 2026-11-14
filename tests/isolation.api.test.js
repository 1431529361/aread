/**
 * P0-01 / P0-05：隔离环境 API 级验证。
 * 两个测试账号的书籍/会话/记忆互不可读写；写操作全部落在临时数据根；
 * 真实 data.db、books、rag_index 不被测试修改。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startIsolatedServer, api, registerUser, REPO_ROOT } = require('./helpers/isolated-server');
const { BOOK_A, BOOK_B, SAME_TITLE_DIFF_CONTENT } = require('./helpers/fixtures');

let srv, fake, userA, userB;

function snapshotRepo() {
    const snap = {};
    const dbPath = path.join(REPO_ROOT, 'data.db');
    snap.dbMtime = fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : null;
    snap.books = fs.existsSync(path.join(REPO_ROOT, 'books'))
        ? fs.readdirSync(path.join(REPO_ROOT, 'books')).sort().join('|') : null;
    snap.ragIndex = fs.existsSync(path.join(REPO_ROOT, 'rag_index'))
        ? fs.readdirSync(path.join(REPO_ROOT, 'rag_index')).sort().join('|') : null;
    return snap;
}

async function uploadBook(base, token, title, content) {
    const form = new FormData();
    form.append('book', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
    const res = await fetch(`${base}/api/books/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, `上传失败: ${JSON.stringify(data)}`);
    return data.book;
}

before(async () => {
    const { startFakeModelServer } = require('./helpers/fake-model-server');
    fake = await startFakeModelServer();
    srv = await startIsolatedServer();
    userA = await registerUser(srv.url, 'p0-alice');
    userB = await registerUser(srv.url, 'p0-bob');
});

after(async () => {
    if (srv) await srv.stop();
    if (fake) await fake.close();
});

test('临时数据根内生成 data.db 与用户书目录，仓库数据不被修改', async () => {
    const before = snapshotRepo();
    const bookA = await uploadBook(srv.url, userA.token, '测试书A', BOOK_A);
    assert.ok(fs.existsSync(path.join(srv.dataRoot, 'data.db')), 'data.db 应在临时数据根');
    assert.ok(fs.existsSync(path.join(srv.dataRoot, 'books', userA.userId, bookA.filename)), '书籍文件应在临时数据根');
    const after = snapshotRepo();
    assert.deepStrictEqual(after, before, '仓库 data.db/books/rag_index 不应被测试修改');
});

test('新用户默认书从仓库只读复制到临时目录', async () => {
    const res = await api(srv.url, '/api/books', { token: userA.token });
    assert.strictEqual(res.status, 200);
    const titles = res.data.books.map(b => b.title);
    assert.ok(titles.includes('百年孤独'), '应自动复制默认书');
    const defaultInTemp = res.data.books.find(b => b.title === '百年孤独');
    assert.ok(fs.existsSync(path.join(srv.dataRoot, 'books', userA.userId, defaultInTemp.filename)));
});

test('书籍跨用户隔离：B 不能读取/删除 A 的书', async () => {
    const listA = await api(srv.url, '/api/books', { token: userA.token });
    const bookA = listA.data.books.find(b => b.title === '测试书A');
    assert.ok(bookA);

    const readB = await api(srv.url, `/api/books/${bookA.id}`, { token: userB.token });
    assert.strictEqual(readB.status, 404);

    const delB = await api(srv.url, `/api/books/${bookA.id}`, { method: 'DELETE', token: userB.token });
    assert.strictEqual(delB.status, 404);

    const listB = await api(srv.url, '/api/books', { token: userB.token });
    assert.ok(!listB.data.books.some(b => b.id === bookA.id), 'B 的书单不应含 A 的书');
});

test('同名不同书：两个用户各自内容互不串扰', async () => {
    await uploadBook(srv.url, userA.token, '示例', BOOK_A);
    await uploadBook(srv.url, userB.token, '示例', SAME_TITLE_DIFF_CONTENT);
    const listA = await api(srv.url, '/api/books', { token: userA.token });
    const listB = await api(srv.url, '/api/books', { token: userB.token });
    const a = listA.data.books.find(b => b.title === '示例');
    const b = listB.data.books.find(b => b.title === '示例');
    assert.notStrictEqual(a.id, b.id);
    const contentA = await api(srv.url, `/api/books/${a.id}`, { token: userA.token });
    const contentB = await api(srv.url, `/api/books/${b.id}`, { token: userB.token });
    assert.ok(contentA.data.content.includes('林远'));
    assert.ok(contentB.data.content.includes('赵铁柱'));
    assert.ok(!contentA.data.content.includes('赵铁柱'));
});

test('会话与记忆跨用户隔离', async () => {
    const convA = await api(srv.url, '/api/conversations/active?bookId=', { token: userA.token });
    assert.strictEqual(convA.status, 200);
    const convId = convA.data.conversation.id;

    const readB = await api(srv.url, `/api/conversations/${convId}/messages`, { token: userB.token });
    assert.strictEqual(readB.status, 404);
    const delB = await api(srv.url, `/api/conversations/${convId}`, { method: 'DELETE', token: userB.token });
    assert.strictEqual(delB.status, 404);

    const memB = await api(srv.url, '/api/memories', { token: userB.token });
    assert.strictEqual(memB.status, 200);
    assert.ok(Array.isArray(memB.data.memories));
});

test('删除书籍仅清理临时目录内文件与索引', async () => {
    const bookB = await uploadBook(srv.url, userB.token, '待删除书', BOOK_B);
    const filePath = path.join(srv.dataRoot, 'books', userB.userId, bookB.filename);
    assert.ok(fs.existsSync(filePath));
    const del = await api(srv.url, `/api/books/${bookB.id}`, { method: 'DELETE', token: userB.token });
    assert.strictEqual(del.status, 200);
    assert.ok(!fs.existsSync(filePath), '临时目录内书籍文件应被删除');
});