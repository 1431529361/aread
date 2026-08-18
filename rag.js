/**
 * RAG 检索增强模块（SQLite 版）
 * - 文本分块：章节边界优先 + 滑动窗口兜底（逻辑不变）
 * - 存储：分块入 rag_chunks 表，向量入 sqlite-vec 虚拟表 rag_vec（data.db 内，退役 rag_index/ JSON）
 * - 向量化：由 embedding.js 解析提供商（阿里云/智谱/硅基流动），统一 1024 维
 * - 检索：向量 Top-N + BM25 Top-N 双路召回 → RRF 融合；任一路失败自动降级
 */

const fs = require('fs');
const path = require('path');
const { getDB, isVecAvailable } = require('./database');
const embedding = require('./embedding');

const LEGACY_RAG_DIR = path.join(__dirname, 'rag_index'); // 旧 JSON 索引目录（仅用于删除清理）
const CHUNK_SIZE = 500;      // 每块最大字符数
const CHUNK_OVERLAP = 100;   // 滑动窗口重叠字符数
const EMBED_BATCH = 10;      // 批量 embed 大小（DashScope 兼容接口批量上限）
const RRF_K = 60;            // RRF 融合常数
const RECALL_N = 10;         // 每路召回数量

// ==================== 中文分词 ====================

// 简易中英文分词：英文按空格/标点，中文按单字 + 双字组合
function tokenize(text) {
    if (!text) return [];
    const tokens = [];
    // 英文单词
    const enWords = text.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || [];
    tokens.push(...enWords);
    // 中文字符序列
    const cnMatches = text.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const seg of cnMatches) {
        // 单字
        for (const ch of seg) tokens.push(ch);
        // 双字（bigram，提升短语召回）
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.substring(i, i + 2));
    }
    return tokens;
}

// ==================== 文本分块 ====================

const CHAPTER_RE = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

/**
 * 按章节边界 + 滑动窗口分块
 */
function chunkText(content) {
    const paragraphs = content.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let currentChapter = '前言';
    let buffer = '';

    const flushBuffer = (chapter) => {
        if (!buffer.trim()) return;
        // 若 buffer 过长，按滑动窗口二次切分
        if (buffer.length > CHUNK_SIZE * 1.5) {
            for (let i = 0; i < buffer.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
                const piece = buffer.substring(i, i + CHUNK_SIZE);
                if (piece.trim()) chunks.push({ chapter, text: piece.trim(), index: chunks.length });
            }
        } else {
            chunks.push({ chapter, text: buffer.trim(), index: chunks.length });
        }
        buffer = '';
    };

    for (const para of paragraphs) {
        if (CHAPTER_RE.test(para)) {
            flushBuffer(currentChapter);
            currentChapter = para.substring(0, 60);
            buffer = para + '\n';
        } else {
            buffer += para + '\n';
            if (buffer.length >= CHUNK_SIZE) flushBuffer(currentChapter);
        }
    }
    flushBuffer(currentChapter);

    // 若整体无章节结构（chunks 为空或单块过大），按纯滑动窗口兜底
    if (chunks.length === 0) {
        for (let i = 0; i < content.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
            const piece = content.substring(i, i + CHUNK_SIZE).trim();
            if (piece) chunks.push({ chapter: '全文', text: piece, index: chunks.length });
        }
    }
    return chunks;
}

// ==================== BM25 检索 ====================

class BM25Index {
    constructor(chunks, k1 = 1.5, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        this.chunks = chunks;
        this.docTokens = chunks.map(c => tokenize(c.text));
        this.docLen = this.docTokens.map(t => t.length);
        this.avgLen = this.docLen.length ? this.docLen.reduce((a, b) => a + b, 0) / this.docLen.length : 0;
        // 词频 + 文档频率
        this.df = {};
        this.tf = this.docTokens.map(tokens => {
            const freq = {};
            for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
            for (const t of Object.keys(freq)) this.df[t] = (this.df[t] || 0) + 1;
            return freq;
        });
        this.N = chunks.length;
    }

    score(queryTokens) {
        const scores = new Array(this.N).fill(0);
        const idfCache = {};
        for (const qt of queryTokens) {
            const df = this.df[qt] || 0;
            if (df === 0) continue;
            if (!(qt in idfCache)) {
                idfCache[qt] = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
            }
            const idf = idfCache[qt];
            for (let i = 0; i < this.N; i++) {
                const f = this.tf[i][qt] || 0;
                if (f === 0) continue;
                const denom = f + this.k1 * (1 - this.b + this.b * (this.docLen[i] / (this.avgLen || 1)));
                scores[i] += idf * (f * (this.k1 + 1)) / denom;
            }
        }
        return scores;
    }

    search(query, topK = 5) {
        const qTokens = tokenize(query);
        const scores = this.score(qTokens);
        return scores
            .map((s, i) => ({ chunk: this.chunks[i], score: s }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
}

// ==================== BM25 索引 LRU 缓存（按 user+book） ====================

const BM25_CACHE_MAX = 5;
const bm25Cache = new Map(); // key: userId:bookId -> BM25Index

function cacheKey(userId, bookId) {
    return `${userId}:${bookId}`;
}

function getBM25(userId, bookId) {
    const key = cacheKey(userId, bookId);
    if (bm25Cache.has(key)) {
        // LRU：命中后移到末尾
        const idx = bm25Cache.get(key);
        bm25Cache.delete(key);
        bm25Cache.set(key, idx);
        return idx;
    }
    const rows = getDB().prepare(
        'SELECT id, chapter, text FROM rag_chunks WHERE user_id = ? AND book_id = ? ORDER BY chunk_index'
    ).all(userId, bookId);
    if (rows.length === 0) return null;
    const index = new BM25Index(rows);
    bm25Cache.set(key, index);
    if (bm25Cache.size > BM25_CACHE_MAX) {
        bm25Cache.delete(bm25Cache.keys().next().value);
    }
    return index;
}

function invalidateBM25(userId, bookId) {
    bm25Cache.delete(cacheKey(userId, bookId));
}

// ==================== 索引构建 ====================

function vecBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
}

/** 删除某书在 DB 中的全部索引数据（chunks + 向量 + meta） */
function deleteDbIndex(db, userId, bookId) {
    if (isVecAvailable()) {
        db.prepare(
            'DELETE FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ?)'
        ).run(userId, bookId);
    }
    db.prepare('DELETE FROM rag_chunks WHERE user_id = ? AND book_id = ?').run(userId, bookId);
    db.prepare('DELETE FROM rag_index_meta WHERE user_id = ? AND book_id = ?').run(userId, bookId);
}

/**
 * 为书籍建立 RAG 索引
 * @param {Object} opts { bookId, userId, content, embedder?, onProgress? }
 *   embedder：embedding.resolveEmbedder() 的返回值；为空则仅建 BM25 索引
 * @returns {Object} { mode, chunkCount, embedError? }
 */
async function indexBook({ bookId, userId, content, embedder, onProgress }) {
    const db = getDB();
    const chunks = chunkText(content);
    onProgress && onProgress({ stage: 'chunked', total: chunks.length });

    // 重建：先清旧数据，再事务写入分块
    const chunkIds = [];
    const insertChunks = db.transaction(() => {
        deleteDbIndex(db, userId, bookId);
        const stmt = db.prepare(
            'INSERT INTO rag_chunks (user_id, book_id, chunk_index, chapter, text) VALUES (?, ?, ?, ?, ?)'
        );
        for (const c of chunks) {
            const info = stmt.run(userId, bookId, c.index, c.chapter, c.text);
            chunkIds.push(Number(info.lastInsertRowid));
        }
    });
    insertChunks();
    invalidateBM25(userId, bookId);

    // 向量化（可用时）：分批 embed 并写入 rag_vec
    let mode = 'bm25';
    let embedError = null;
    if (embedder && isVecAvailable()) {
        try {
            onProgress && onProgress({ stage: 'embedding', total: chunks.length });
            const insertVec = db.prepare('INSERT INTO rag_vec (rowid, embedding) VALUES (?, ?)');
            for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
                const batch = chunks.slice(i, i + EMBED_BATCH).map(c => c.text);
                const vectors = await embedding.embedTexts(embedder, batch);
                const writeBatch = db.transaction(() => {
                    for (let j = 0; j < vectors.length; j++) {
                        // vec0 要求 rowid 严格为 INTEGER，用 BigInt 绑定避免被当作 REAL
                        insertVec.run(BigInt(chunkIds[i + j]), vecBuffer(vectors[j]));
                    }
                });
                writeBatch();
                onProgress && onProgress({ stage: 'embedding', done: Math.min(i + EMBED_BATCH, chunks.length), total: chunks.length });
            }
            mode = 'embedding+bm25';
        } catch (e) {
            console.warn('Embedding 建库失败，回退为纯 BM25 索引:', e.message);
            embedError = e.message;
            // 清掉可能写入一半的向量，保持数据一致
            try {
                db.prepare(
                    'DELETE FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ?)'
                ).run(userId, bookId);
            } catch {}
        }
    }

    db.prepare(`
        INSERT INTO rag_index_meta (user_id, book_id, mode, embed_provider, embed_model, dims, chunk_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, book_id) DO UPDATE SET
            mode = excluded.mode, embed_provider = excluded.embed_provider,
            embed_model = excluded.embed_model, dims = excluded.dims,
            chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at
    `).run(
        userId, bookId, mode,
        mode === 'embedding+bm25' ? embedder.providerId : null,
        mode === 'embedding+bm25' ? embedder.model : null,
        mode === 'embedding+bm25' ? embedder.dims : null,
        chunks.length
    );

    onProgress && onProgress({ stage: 'done', mode, chunkCount: chunks.length });
    const result = { mode, chunkCount: chunks.length };
    if (embedError) result.embedError = embedError;
    return result;
}

// ==================== 检索 ====================

function getMeta(userId, bookId) {
    return getDB().prepare('SELECT * FROM rag_index_meta WHERE user_id = ? AND book_id = ?').get(userId, bookId) || null;
}

/** 向量 KNN 召回（返回 [{id, chapter, text}]，按相似度降序） */
async function vectorRecall(userId, bookId, meta, query, topN) {
    if (!isVecAvailable() || meta.mode !== 'embedding+bm25') return null;
    // 必须用建库时的同一提供商/模型 embed query
    const embedder = embedding.resolveEmbedder(userId, meta.embed_provider);
    if (!embedder || embedder.model !== meta.embed_model) return null; // Key 已删或模型已变 → 跳过向量路
    const [qVec] = await embedding.embedTexts(embedder, [query], { retries: 1, timeoutMs: 15000 });
    const rows = getDB().prepare(`
        SELECT v.rowid AS id, v.distance AS distance
        FROM rag_vec v
        WHERE v.embedding MATCH ?
          AND v.rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ?)
          AND k = ?
        ORDER BY v.distance
    `).all(vecBuffer(qVec), userId, bookId, topN);
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id);
    const chunkRows = getDB().prepare(
        `SELECT id, chapter, text FROM rag_chunks WHERE id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    const byId = new Map(chunkRows.map(r => [r.id, r]));
    return rows.map(r => byId.get(r.id)).filter(Boolean);
}

/** BM25 召回（返回 [{id, chapter, text}]，按分数降序） */
function bm25Recall(userId, bookId, query, topN) {
    const index = getBM25(userId, bookId);
    if (!index) return [];
    return index.search(query, topN).map(h => h.chunk);
}

/**
 * RRF 融合：score = Σ 1/(RRF_K + rank)，按 chunk id 去重
 */
function rrfFuse(lists, topK) {
    const scores = new Map(); // id -> { chunk, score }
    for (const list of lists) {
        if (!list) continue;
        list.forEach((chunk, rank) => {
            const entry = scores.get(chunk.id) || { chunk, score: 0 };
            entry.score += 1 / (RRF_K + rank + 1);
            scores.set(chunk.id, entry);
        });
    }
    return [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(e => ({ text: e.chunk.text, chapter: e.chunk.chapter, score: Number(e.score.toFixed(4)) }));
}

/**
 * 混合检索主入口：向量 + BM25 双路召回 → RRF 融合
 * query 向量化在内部按建库 meta 自动解析，调用方无需关心提供商
 * @returns {Array<{ text, chapter, score }>} Top-K 片段
 */
async function retrieveAsync(userId, bookId, query, topK = 5) {
    const meta = getMeta(userId, bookId);
    if (!meta || meta.chunk_count === 0) return [];

    let vecHits = null;
    try {
        vecHits = await vectorRecall(userId, bookId, meta, query, RECALL_N);
    } catch (e) {
        console.warn('向量检索失败，降级 BM25:', e.message);
        vecHits = null;
    }

    let bm25Hits = [];
    try {
        bm25Hits = bm25Recall(userId, bookId, query, RECALL_N);
    } catch (e) {
        console.warn('BM25 检索失败:', e.message);
    }

    return rrfFuse([vecHits, bm25Hits], topK);
}

/**
 * 同步检索（纯 BM25，供不便 async 的调用方使用）
 */
function retrieve(userId, bookId, query, topK = 5) {
    const meta = getMeta(userId, bookId);
    if (!meta || meta.chunk_count === 0) return [];
    const hits = bm25Recall(userId, bookId, query, topK);
    return hits.map((c, i) => ({ text: c.text, chapter: c.chapter, score: 1 / (i + 1) }));
}

// ==================== 状态与删除 ====================

function getIndexStatus(userId, bookId) {
    const meta = getMeta(userId, bookId);
    if (!meta) return { indexed: false };
    return {
        indexed: true,
        mode: meta.mode,
        chunkCount: meta.chunk_count,
        indexedAt: meta.indexed_at,
        embedProvider: meta.embed_provider,
        embedModel: meta.embed_model
    };
}

function deleteIndex(userId, bookId) {
    deleteDbIndex(getDB(), userId, bookId);
    invalidateBM25(userId, bookId);
    // 顺带清理旧版 JSON 索引文件
    try {
        const legacy = path.join(LEGACY_RAG_DIR, userId, `${bookId}.json`);
        if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    } catch {}
}

module.exports = {
    chunkText,
    tokenize,
    indexBook,
    retrieve,
    retrieveAsync,
    getIndexStatus,
    deleteIndex
};
