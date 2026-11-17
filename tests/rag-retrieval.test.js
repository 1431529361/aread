/**
 * P1b R2 检索/版本确定性测试（进程内直连隔离临时库 + 假 Embedding 服务）。
 * 覆盖 R-T06/07/10/13/14/20：版本隔离不混版、向量校验、查询快照、软预算超时/取消、
 * empty/error/unavailable/stale/legacy 区分、清理无孤儿向量。不联网（仅本地假模型）、不写业务原件。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startFakeModelServer } = require('./helpers/fake-model-server');
const { BOOK_A, BOOK_B } = require('./helpers/fixtures');

let fake, root, database, rag, embedding, TU, db;
const KEY = 'sk-r2-unit-0123456789abcdef';
const U1 = 'u-r2-1', U2 = 'u-r2-2';

function makeBook(userId, title, content) {
    const bookId = 'book-' + crypto.randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO books_meta (id, user_id, title, filename, original_name, format, size, size_formatted)
                VALUES (?, ?, ?, ?, ?, 'TXT', ?, '1 KB')`)
        .run(bookId, userId, title, bookId + '.txt', title + '.txt', content.length);
    return { bookId, content, hash: TU.contentHash(TU.normalizeText(content)) };
}
const embedder = () => embedding.resolveEmbedder(U1);

before(async () => {
    fake = await startFakeModelServer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-r2-'));
    process.env.READER_DATA_ROOT = root;
    database = require('../database');
    rag = require('../rag');
    embedding = require('../embedding');
    TU = require('../text-utils');
    db = await database.initDB();
    for (const u of [U1, U2]) db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(u, u, 'x');
    embedding.init({ getApiKey: () => KEY });
    embedding.saveEmbeddingSettings(U1, { provider: 'custom', custom: { baseUrl: `${fake.url}/v1`, model: 'fake-embed' } });
    embedding.saveEmbeddingSettings(U2, { provider: 'custom', custom: { baseUrl: `${fake.url}/v1`, model: 'fake-embed' } });
});
after(async () => {
    try { db.close(); } catch {}
    if (fake) await fake.close();
    delete process.env.READER_DATA_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
});

test('R-T06 版本隔离：重建后只召回新版本块，跨用户不污染', async () => {
    const b = makeBook(U1, '隔离书', BOOK_A);
    const r1 = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    assert.strictEqual(r1.mode, 'embedding+bm25');
    const v1 = r1.indexVersion;
    const ret1 = await rag.retrieveDetailed(U1, b.bookId, '青色灯塔的守塔人是谁', 5, { expectedContentHash: b.hash });
    assert.strictEqual(ret1.status, 'ok');
    assert.ok(ret1.candidates.every(c => c.locator && c.text === b.content.slice(c.locator.start, c.locator.end)));
    const ids1 = new Set(db.prepare('SELECT id FROM rag_chunks WHERE index_version = ?').all(v1).map(r => r.id));
    assert.ok(ret1.candidates.every(c => ids1.has(c.chunkId)));

    // 重建（不同分块参数 → 新块集合）
    const r2 = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder(), chunkerConfig: { targetSize: 300, longThreshold: 450, overlap: 60 } });
    const v2 = r2.indexVersion;
    assert.notStrictEqual(v1, v2);
    const ret2 = await rag.retrieveDetailed(U1, b.bookId, '青色灯塔的守塔人是谁', 5, { expectedContentHash: b.hash });
    const ids2 = new Set(db.prepare('SELECT id FROM rag_chunks WHERE index_version = ?').all(v2).map(r => r.id));
    assert.ok(ret2.candidates.every(c => ids2.has(c.chunkId)), '不得混入旧版本块');
    assert.strictEqual(ret2.diagnostics.indexVersion, v2);

    // 跨用户：U2 的同名不同内容书，检索 U1 独特标记不应命中
    const b2 = makeBook(U2, '隔离书', BOOK_B);
    await rag.indexBook({ bookId: b2.bookId, userId: U2, content: b2.content, embedder: embedding.resolveEmbedder(U2) });
    const retB = await rag.retrieveDetailed(U2, b2.bookId, '青色灯塔 老周 航海日志', 5, { expectedContentHash: b2.hash });
    assert.ok(!retB.candidates.some(c => c.text.includes('老周') || c.text.includes('航海日志')));
});

test('R-T07 向量校验：维度错/NaN/重复index/缺失index 拒绝该批；乱序带index可重排', async () => {
    for (const m of ['dim', 'nan', 'dupIndex', 'missingIndex']) {
        await fake.control({ embedMutate: m });
        const b = makeBook(U1, '坏向量书-' + m, BOOK_A);
        const r = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
        // 首次建库无 active：块完整可发布 BM25，但绝不发布混合版本
        assert.strictEqual(r.mode, 'bm25', `${m} 不应发布混合版本`);
        assert.strictEqual(r.vectorCount, 0);
        assert.ok(r.warnings.some(w => w.code === 'EMBED_FAILED'));
        const vecRows = db.prepare('SELECT COUNT(*) c FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE index_version = ?)').get(r.indexVersion).c;
        assert.strictEqual(vecRows, 0, `${m} 不得留下部分向量`);
    }
    await fake.control({ embedMutate: 'shuffle' });
    const bok = makeBook(U1, '乱序书', BOOK_A);
    const rok = await rag.indexBook({ bookId: bok.bookId, userId: U1, content: bok.content, embedder: embedder() });
    assert.strictEqual(rok.mode, 'embedding+bm25', '带正确index的乱序应可重排通过');
    assert.strictEqual(rok.vectorCount, rok.chunkCount);
    await fake.control({ embedMutate: null });

    // 已有 hybrid active 时坏向量重建 → 保留旧混合索引，新构建 failed
    await fake.control({ embedMutate: 'dim' });
    const rfail = await rag.indexBook({ bookId: bok.bookId, userId: U1, content: bok.content, embedder: embedder() });
    assert.strictEqual(rfail.published, false);
    assert.strictEqual(rfail.mode, 'embedding+bm25', '保留旧混合 active');
    const st = rag.getIndexStatus(U1, bok.bookId, bok.hash);
    assert.strictEqual(st.usable, true);
    assert.strictEqual(st.build.state, 'failed');
    await fake.control({ embedMutate: null });
});

test('R-T10 查询快照：发布新版本时在途旧查询只用旧版本，旧版未被提前清理', async () => {
    const b = makeBook(U1, '快照书', BOOK_A);
    const r1 = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    const v1 = r1.indexVersion;
    const ids1 = new Set(db.prepare('SELECT id FROM rag_chunks WHERE index_version = ?').all(v1).map(r => r.id));

    await fake.control({ latencyMs: 1200 });
    const pending = rag.retrieveDetailed(U1, b.bookId, '灯塔守塔人', 5, { expectedContentHash: b.hash });
    await new Promise(r => setTimeout(r, 150)); // 向量请求在途
    await fake.control({ latencyMs: 0 });
    const r2 = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    const r3 = await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    // v1 既非 active 也非前一个成功版本，但在途查询持有 → 不得清理
    const stillThere = db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE index_version = ?').get(v1).c;
    assert.ok(stillThere > 0, '在途查询的旧版本块不得被清理');
    const ret = await pending;
    assert.strictEqual(ret.diagnostics.indexVersion, v1, '查询固定用自己快照版本');
    assert.ok(ret.candidates.every(c => ids1.has(c.chunkId)), '不混入新版本块');
    // 查询释放后再次构建 → v1 派生行被清理
    await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    const after = db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE index_version = ?').get(v1).c;
    assert.strictEqual(after, 0, '使用计数归零后清理旧版本');
    assert.notStrictEqual(r2.indexVersion, r3.indexVersion);
});

test('R-T13 向量软预算超时降级 BM25；用户取消则终止', async () => {
    const b = makeBook(U1, '超时书', BOOK_A);
    await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    await fake.control({ latencyMs: 9000 });
    const t0 = Date.now();
    const ret = await rag.retrieveDetailed(U1, b.bookId, '青色灯塔的守塔人是谁', 5, { expectedContentHash: b.hash });
    const elapsed = Date.now() - t0;
    assert.strictEqual(ret.status, 'ok', 'BM25 命中应 ok');
    assert.ok(elapsed < 8800, `应在软预算内降级（实际 ${elapsed}ms）`);
    assert.ok(ret.diagnostics.paths.some(p => p.method === 'vector' && p.code === 'VECTOR_TIMEOUT'));
    assert.ok(ret.diagnostics.warnings.some(w => w.code === 'VECTOR_TIMEOUT'));
    assert.ok(ret.candidates.every(c => c.method === 'bm25'), '降级后只标 bm25');
    assert.ok(ret.candidates.some(c => c.text.includes('老周')));

    // 用户取消 → 抛 AbortError，不当普通降级
    const ac = new AbortController();
    const p = rag.retrieveDetailed(U1, b.bookId, '灯塔', 5, { expectedContentHash: b.hash, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, e => e.name === 'AbortError');
    await fake.control({ latencyMs: 0 });
});

test('R-T14 empty/error/unavailable/legacy/stale 分别可辨', async () => {
    const b = makeBook(U1, '状态书', BOOK_A);
    // unavailable：无索引
    const un = await rag.retrieveDetailed(U1, b.bookId, '灯塔', 5, { expectedContentHash: b.hash });
    assert.strictEqual(un.status, 'unavailable');
    assert.strictEqual(un.error.code, 'INDEX_UNAVAILABLE');
    // legacy：有 meta 但 active_version NULL
    db.prepare("INSERT INTO rag_index_meta (user_id, book_id, mode, chunk_count) VALUES (?, ?, 'bm25', 1)").run(U1, b.bookId);
    const lg = await rag.retrieveDetailed(U1, b.bookId, '灯塔', 5, { expectedContentHash: b.hash });
    assert.strictEqual(lg.error.code, 'INDEX_LEGACY');
    db.prepare('DELETE FROM rag_index_meta WHERE user_id = ? AND book_id = ?').run(U1, b.bookId);
    // 正常建库
    await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder() });
    // stale：请求 hash 与索引不同
    const st = await rag.retrieveDetailed(U1, b.bookId, '灯塔', 5, { expectedContentHash: 'txt-v1:' + '0'.repeat(64) });
    assert.strictEqual(st.error.code, 'INDEX_STALE');
    // empty：执行成功但无命中（纯 BM25 书 + 无 token 重叠查询；向量 KNN 恒返回近邻，故用 BM25-only）
    const emb = makeBook(U1, '空命中书', BOOK_A);
    await rag.indexBook({ bookId: emb.bookId, userId: U1, content: emb.content, embedder: null });
    const em = await rag.retrieveDetailed(U1, emb.bookId, 'zzzqqqxxx', 5, { expectedContentHash: emb.hash });
    assert.strictEqual(em.status, 'empty');
    assert.strictEqual(em.candidates.length, 0);
    assert.strictEqual(em.error, null);
    // error：两路均失败（BM25 表缺失 + 向量跳过）——临时重命名表模拟故障
    const bm = makeBook(U1, '故障书', BOOK_A);
    await rag.indexBook({ bookId: bm.bookId, userId: U1, content: bm.content, embedder: null }); // bm25-only
    db.exec('ALTER TABLE rag_chunks RENAME TO rag_chunks_bak');
    try {
        const er = await rag.retrieveDetailed(U1, bm.bookId, '灯塔', 5, { expectedContentHash: bm.hash });
        assert.strictEqual(er.status, 'error');
        assert.strictEqual(er.error.code, 'RETRIEVAL_FAILED');
    } finally {
        db.exec('ALTER TABLE rag_chunks_bak RENAME TO rag_chunks');
    }
});

test('R-T20 清理只删派生版本：rag_vec 无孤儿，书籍元数据不动', async () => {
    const b = makeBook(U1, '清理书', BOOK_A);
    for (let i = 0; i < 4; i++) {
        await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: embedder(), chunkerConfig: { targetSize: 400 + i * 50, longThreshold: 750, overlap: 80 } });
    }
    // 所有 rag_vec rowid 必须对应现存 rag_chunks
    const orphans = db.prepare('SELECT COUNT(*) c FROM rag_vec WHERE rowid NOT IN (SELECT id FROM rag_chunks)').get().c;
    assert.strictEqual(orphans, 0, '不得有孤儿向量');
    // 仅保留当前与前一个成功版本的块
    const versionsWithChunks = db.prepare('SELECT DISTINCT index_version FROM rag_chunks WHERE user_id = ? AND book_id = ?').all(U1, b.bookId);
    assert.ok(versionsWithChunks.length <= 2, `最多保留两个版本块（实际 ${versionsWithChunks.length}）`);
    assert.ok(db.prepare('SELECT 1 FROM books_meta WHERE id = ?').get(b.bookId), '书籍元数据不动');
    // 删除索引：全部派生行清空
    rag.deleteIndex(U1, b.bookId);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE book_id = ?').get(b.bookId).c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rag_index_versions WHERE book_id = ?').get(b.bookId).c, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rag_vec WHERE rowid NOT IN (SELECT id FROM rag_chunks)').get().c, 0);
});

test('P3 邻接扩展：同章段落边界扩展、不跨章、上限与slice一致', async () => {
    const b = makeBook(U1, '扩展书', BOOK_A);
    await rag.indexBook({ bookId: b.bookId, userId: U1, content: b.content, embedder: null });
    const base = await rag.retrieveDetailed(U1, b.bookId, '青色灯塔的守塔人是谁', 5, { expectedContentHash: b.hash });
    assert.ok(base.candidates.length > 0);
    const exp = await rag.retrieveDetailed(U1, b.bookId, '青色灯塔的守塔人是谁', 5, { expectedContentHash: b.hash, expandAdjacent: true, content: b.content, expandCap: 1500 });
    assert.strictEqual(exp.status, 'ok');
    assert.ok(exp.diagnostics.expansion && exp.diagnostics.expansion.applied);
    const chapters = TU.parseChapters(b.content);
    for (const c of exp.candidates) {
        assert.ok(c.locator, '扩展后仍有真实 locator');
        assert.strictEqual(c.text, b.content.slice(c.locator.start, c.locator.end), '扩展 text 等于原文 slice');
        assert.ok(c.locator.end - c.locator.start <= 1500, '不超过上限');
        const ch = chapters.find(x => c.locator.start >= x.start && c.locator.end <= x.end);
        assert.ok(ch, '扩展不跨章节');
    }
    // 扩展后区间应不短于原命中（向段落边界扩展）
    const baseLoc = base.candidates[0].locator;
    const expHit = exp.candidates.find(c => c.locator.start <= baseLoc.start && c.locator.end >= baseLoc.end);
    assert.ok(expHit, '扩展区间应覆盖原命中');
});

test('R-T09 重启遗留 building 标 failed（中断），不自动重放', async () => {
    const b = makeBook(U1, '遗留书', BOOK_A);
    db.prepare(`INSERT INTO rag_index_versions (id, user_id, book_id, content_hash, normalization_version, chunker_version, chunker_config_json, mode, status)
                VALUES ('stale-v', ?, ?, ?, 'txt-v1', 'range-v1', '{}', 'bm25', 'building')`).run(U1, b.bookId, b.hash);
    const n = rag.recoverStaleBuilds();
    assert.ok(n >= 1);
    const v = db.prepare("SELECT status, error_code FROM rag_index_versions WHERE id = 'stale-v'").get();
    assert.strictEqual(v.status, 'failed');
    assert.strictEqual(v.error_code, 'INTERRUPTED');
});