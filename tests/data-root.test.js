/**
 * P0-01 数据根隔离单元测试：默认路径不变、覆盖跟随、护栏拒绝危险路径。
 * 仅 require database.js（不调用 initDB），不触碰任何真实数据库。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const database = require('../database');
const REPO_ROOT = path.join(__dirname, '..');

let saved;
beforeEach(() => { saved = process.env.READER_DATA_ROOT; delete process.env.READER_DATA_ROOT; });
afterEach(() => {
    if (saved === undefined) delete process.env.READER_DATA_ROOT;
    else process.env.READER_DATA_ROOT = saved;
});

test('默认数据根为仓库根，业务路径保持不变', () => {
    assert.strictEqual(database.getDataRoot(), REPO_ROOT);
    assert.strictEqual(database.getDbPath(), path.join(REPO_ROOT, 'data.db'));
    assert.strictEqual(database.getBooksDir(), path.join(REPO_ROOT, 'books'));
    assert.strictEqual(database.getRagIndexDir(), path.join(REPO_ROOT, 'rag_index'));
});

test('设置 READER_DATA_ROOT 后四处路径全部跟随', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-p0-unit-'));
    try {
        process.env.READER_DATA_ROOT = tmp;
        assert.strictEqual(database.getDataRoot(), path.resolve(tmp));
        assert.strictEqual(database.getDbPath(), path.join(tmp, 'data.db'));
        assert.strictEqual(database.getBooksDir(), path.join(tmp, 'books'));
        assert.strictEqual(database.getRagIndexDir(), path.join(tmp, 'rag_index'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('护栏：数据根为仓库根时拒绝', () => {
    process.env.READER_DATA_ROOT = REPO_ROOT;
    assert.throws(() => database.getDataRoot(), /冲突/);
});

test('护栏：数据根为仓库上级目录时拒绝', () => {
    process.env.READER_DATA_ROOT = path.dirname(REPO_ROOT);
    assert.throws(() => database.getDataRoot(), /冲突/);
});

test('护栏：数据根为业务 books 目录或其子目录时拒绝', () => {
    process.env.READER_DATA_ROOT = path.join(REPO_ROOT, 'books');
    assert.throws(() => database.getDataRoot(), /冲突/);
    process.env.READER_DATA_ROOT = path.join(REPO_ROOT, 'books', 'some-user');
    assert.throws(() => database.getDataRoot(), /冲突/);
});

test('护栏：数据根为 rag_index 目录时拒绝', () => {
    process.env.READER_DATA_ROOT = path.join(REPO_ROOT, 'rag_index');
    assert.throws(() => database.getDataRoot(), /冲突/);
});

test('护栏：空白值视为未设置，回退默认业务路径', () => {
    process.env.READER_DATA_ROOT = '   ';
    assert.strictEqual(database.getDataRoot(), REPO_ROOT);
});