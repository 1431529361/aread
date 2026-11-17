/**
 * P1b R1 确定性测试：规范文本/章节/范围分块（R-T01~T05）+ web_002 迁移（旧库副本、幂等）。
 * 不联网、不写业务原件；迁移在临时数据根验证。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TU = require('../text-utils');

// ---------- R-T01 规范化 ----------
test('R-T01 BOM/CRLF/单CR/空行混合：规范化确定，等价换行hash一致，内部空格不丢', () => {
    const raw = '﻿第一行  带空格\r\n第二行\r第三行\n\n\n第四行\t缩进\n';
    const norm = TU.normalizeText(raw);
    assert.strictEqual(norm, '第一行  带空格\n第二行\n第三行\n\n\n第四行\t缩进\n');
    const a = TU.normalizeText('甲\r\n乙\r丙\n\n丁');
    const b = TU.normalizeText('甲\n乙\n丙\n\n丁');
    assert.strictEqual(a, b);
    assert.strictEqual(TU.contentHash(a), TU.contentHash(b));
    assert.match(TU.contentHash(a), /^txt-v1:[0-9a-f]{64}$/);
    // 不 trim、不合并空行、不做 Unicode 归一化
    assert.strictEqual(TU.normalizeText('  前后空格  \n\n\n  中间'), '  前后空格  \n\n\n  中间');
    assert.strictEqual(TU.normalizeText('ｅａｄ'), 'ｅａｄ'); // 全角不转半角
    assert.strictEqual(TU.normalizeText(''), '');
});

// ---------- R-T02 重复段落/重复章节名 ----------
test('R-T02 重复段落与重复章节名：不同出现位置有不同locator', () => {
    const content = '第一章 同名\n重复段落XYZ。\n第二章 同名\n重复段落XYZ。\n';
    const chapters = TU.parseChapters(content);
    assert.strictEqual(chapters.length, 2);
    assert.notStrictEqual(chapters[0].id, chapters[1].id);
    assert.strictEqual(chapters[0].ordinal, 1);
    assert.strictEqual(chapters[1].ordinal, 2);
    const chunks = TU.chunkContent(content, TU.P1B_CHUNKER_CONFIG);
    const hits = chunks.filter(c => c.text.includes('重复段落XYZ'));
    assert.ok(hits.length >= 2, '两处重复段落应分别成块');
    const locs = new Set(hits.map(c => `${c.start}:${c.end}`));
    assert.strictEqual(locs.size, hits.length, 'locator 必须互不相同');
    for (const c of hits) {
        assert.strictEqual(c.text, content.slice(c.start, c.end));
        assert.strictEqual(content.indexOf('重复段落XYZ', c.start) >= c.start, true);
    }
});

// ---------- R-T03 覆盖/边界 ----------
function assertCoverage(content, chunks) {
    const covered = new Uint8Array(content.length);
    for (const c of chunks) {
        assert.ok(Number.isInteger(c.start) && Number.isInteger(c.end), '偏移为整数');
        assert.ok(c.start >= 0 && c.end <= content.length && c.start < c.end, '半开区间合法');
        assert.strictEqual(c.text, content.slice(c.start, c.end), 'text 必须等于原文 slice');
        for (let i = c.start; i < c.end; i++) covered[i] = 1;
    }
    for (let i = 0; i < content.length; i++) {
        if (content[i].trim()) assert.strictEqual(covered[i], 1, `非空白码元 ${i} 未被覆盖`);
    }
}

test('R-T03 长章/超长单段/末尾短段：全覆盖、无跨章、不漏尾、不死循环', () => {
    const longPara = '这是一个超长段落。'.repeat(300); // ~2700 码元单段
    const content = `第一章 长章\n${longPara}\n\n短段甲。\n短段乙。\n第二章 短章\n只有一句。\n末尾短段不丢弃。`;
    const chapters = TU.parseChapters(content);
    const chunks = TU.chunkContent(content, TU.P1B_CHUNKER_CONFIG);
    assert.ok(chunks.length > 3);
    assertCoverage(content, chunks);
    // 无跨章
    for (const c of chunks) {
        const ch = chapters.find(x => x.id === c.chapterId);
        assert.ok(ch && c.start >= ch.start && c.end <= ch.end, '块不得跨章节');
    }
    // 末尾短段存在
    assert.ok(chunks.some(c => c.text.includes('末尾短段不丢弃')));
    // 超长段滑窗：存在重叠且每块 ≤ target+1（代理对调整余量）
    const longChunks = chunks.filter(c => c.chapterId === chapters[0].id);
    assert.ok(longChunks.length >= 5);
    for (let i = 1; i < longChunks.length; i++) {
        const prev = longChunks[i - 1], cur = longChunks[i];
        if (cur.start < prev.end) assert.ok(prev.end - cur.start <= 101, '滑窗重叠约100');
    }
    // 无章节文本 → 全文单章
    const noToc = TU.parseChapters('没有目录的文本。\n第二段。');
    assert.strictEqual(noToc.length, 1);
    assert.strictEqual(noToc[0].title, '全文');
    assertCoverage('没有目录的文本。\n第二段。', TU.chunkContent('没有目录的文本。\n第二段。'));
    // 前导非空内容 → 前言
    const pre = TU.parseChapters('这是前言内容。\n第一章 正文\n正文内容。');
    assert.strictEqual(pre[0].title, '前言');
    assert.strictEqual(pre[1].title, '第一章 正文');
    assert.strictEqual(pre[0].end, pre[1].start);
});

// ---------- R-T04 代理对 ----------
test('R-T04 代理对位于分块边界：不切断，slice与text完全相同', () => {
    // 段落起点 s=7（标题行后），emoji 高代理位于 s+499，使首窗 end=s+500 恰好切在对中间
    const filler = '填'.repeat(499);
    const tail = '尾'.repeat(400);
    const content = `第一章 边界\n${filler}😀${tail}\n`;
    assert.ok(content.charCodeAt(7 + 499) >= 0xD800 && content.charCodeAt(7 + 499) <= 0xDBFF);
    const chunks = TU.chunkContent(content, TU.P1B_CHUNKER_CONFIG);
    assert.ok(chunks.length >= 2, '超长段应滑窗切分');
    assertCoverage(content, chunks);
    for (const c of chunks) {
        for (let i = c.start; i < c.end; i++) {
            const code = content.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                assert.ok(i + 1 < c.end, '高代理对不得在块尾被切断');
                assert.ok(content.charCodeAt(i + 1) >= 0xDC00);
            }
            if (code >= 0xDC00 && code <= 0xDFFF) {
                assert.ok(i > c.start, '低代理对不得在块首被切断');
            }
        }
    }
    // 507 落在代理对中间 → 边界后移
    const s = TU.sliceAtSafeBoundary(content, 7 + 500, 7 + 502);
    assert.strictEqual(s.start, 7 + 501);
    assert.strictEqual(s.text, content.slice(s.start, s.end));
});

// ---------- R-T05 全空白 ----------
test('R-T05 全空白TXT：拒绝建空索引（解析/分块为空）', () => {
    for (const blank of ['', '   ', '\n\n\n', ' \t\n \r\n']) {
        const norm = TU.normalizeText(blank);
        assert.deepStrictEqual(TU.parseChapters(norm), []);
        assert.deepStrictEqual(TU.chunkContent(norm), []);
    }
});

// ---------- 分块参数校验 ----------
test('分块参数非法时拒绝', () => {
    assert.throws(() => TU.chunkContent('内容', { targetSize: 0 }));
    assert.throws(() => TU.chunkContent('内容', { overlap: 500, targetSize: 500 }));
    assert.throws(() => TU.chunkContent('内容', { longThreshold: 100, targetSize: 500 }));
});

// ---------- P3 选定默认配置 ----------
test('P3 默认分块配置为 1200/1800/240，且长书覆盖完整', () => {
    assert.deepStrictEqual(TU.DEFAULT_CHUNKER_CONFIG, { targetSize: 1200, longThreshold: 1800, overlap: 240 });
    assert.deepStrictEqual(TU.P1B_CHUNKER_CONFIG, { targetSize: 500, longThreshold: 750, overlap: 100 });
    const long = '第一章 长\n' + '段落内容。'.repeat(400) + '\n第二章 短\n短内容。\n';
    const chunks = TU.chunkContent(long); // 默认
    assertCoverage(long, chunks);
    for (const c of chunks) assert.ok(c.end - c.start <= 1800 + 1, '默认配置块不超过 longThreshold 余量');
});

// ---------- 迁移：旧库副本 + 幂等 ----------
test('web_002 迁移：旧schema副本加列不删数据，重复执行幂等', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-r1-mig-'));
    const dbPath = path.join(root, 'data.db');
    const Database = require('better-sqlite3');
    // 构造旧 schema（web_001 已应用，rag 表为旧结构）
    const old = new Database(dbPath);
    old.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_migrations (id) VALUES ('web_001_request_contract');
        CREATE TABLE rag_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, book_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chapter TEXT, text TEXT NOT NULL);
        CREATE TABLE rag_index_meta (user_id TEXT NOT NULL, book_id TEXT NOT NULL, mode TEXT NOT NULL, embed_provider TEXT, embed_model TEXT, dims INTEGER, chunk_count INTEGER DEFAULT 0, indexed_at TEXT, PRIMARY KEY (user_id, book_id));
        INSERT INTO rag_chunks (user_id, book_id, chunk_index, chapter, text) VALUES ('u1', 'b1', 0, '第一章', '旧块内容');
        INSERT INTO rag_index_meta (user_id, book_id, mode, chunk_count) VALUES ('u1', 'b1', 'bm25', 1);
    `);
    old.close();

    process.env.READER_DATA_ROOT = root;
    const database = require('../database');
    const db = await database.initDB();
    const chunk = db.prepare('SELECT * FROM rag_chunks WHERE user_id = ?').get('u1');
    assert.strictEqual(chunk.text, '旧块内容', '旧块保留');
    assert.strictEqual(chunk.index_version, null);
    assert.strictEqual(chunk.start_offset, null);
    const meta = db.prepare('SELECT * FROM rag_index_meta WHERE user_id = ?').get('u1');
    assert.strictEqual(meta.active_version, null, '旧meta active_version=NULL');
    // 条件唯一索引：旧行 index_version NULL 不受唯一约束
    db.prepare('INSERT INTO rag_chunks (user_id, book_id, chunk_index, chapter, text) VALUES (?, ?, ?, ?, ?)').run('u1', 'b1', 0, '第一章', '另一旧块');
    // 新块唯一约束生效
    db.prepare('INSERT INTO rag_chunks (user_id, book_id, chunk_index, chapter, text, index_version) VALUES (?, ?, ?, ?, ?, ?)').run('u1', 'b1', 0, 'c', 'x', 'v1');
    assert.throws(() => db.prepare('INSERT INTO rag_chunks (user_id, book_id, chunk_index, chapter, text, index_version) VALUES (?, ?, ?, ?, ?, ?)').run('u1', 'b1', 0, 'c', 'y', 'v1'));
    // 同书仅一个 building
    db.prepare("INSERT INTO rag_index_versions (id, user_id, book_id, content_hash, normalization_version, chunker_version, chunker_config_json, mode, status) VALUES ('v1', 'u1', 'b1', 'h', 'txt-v1', 'range-v1', '{}', 'bm25', 'building')").run();
    assert.throws(() => db.prepare("INSERT INTO rag_index_versions (id, user_id, book_id, content_hash, normalization_version, chunker_version, chunker_config_json, mode, status) VALUES ('v2', 'u1', 'b1', 'h', 'txt-v1', 'range-v1', '{}', 'bm25', 'building')").run());
    // 其他书不互斥
    db.prepare("INSERT INTO rag_index_versions (id, user_id, book_id, content_hash, normalization_version, chunker_version, chunker_config_json, mode, status) VALUES ('v3', 'u1', 'b2', 'h', 'txt-v1', 'range-v1', '{}', 'bm25', 'building')").run();
    db.close();

    // 幂等：重新 initDB 不重复建数据
    const db2 = await database.initDB();
    const applied = db2.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
    assert.strictEqual(applied, 4);
    assert.strictEqual(db2.prepare('SELECT COUNT(*) c FROM rag_chunks').get().c, 3);
    db2.close();
    delete process.env.READER_DATA_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
});