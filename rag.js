/**
 * RAG 检索增强模块（P1b R2：版本化索引 + 带定位召回）
 * - 索引按版本构建/发布：building/ready/failed/cancelled/retired；同书互斥；失败保留最后可用版本
 * - 分块基于规范文本范围（text-utils），每块带 contentHash/chapter/locator
 * - 检索固定单一 active 版本快照（使用计数防混版/防清理），BM25 立即执行 + 向量软预算并发
 * - 返回 SC-1.1 §6.2 RetrievalResult：真实路径诊断，hybrid 只在两路实际参与时标注
 * - 向量 KNN 限定 user+book+index_version；Embedding 配置指纹不兼容时降级 BM25
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDB, isVecAvailable, getRagIndexDir } = require('./database');
const embedding = require('./embedding');
const rerank = require('./rerank');
const TU = require('./text-utils');

const LEGACY_RAG_DIR = getRagIndexDir(); // 旧 JSON 索引目录（仅用户主动删除索引时清理）
const EMBED_BATCH = 10;      // 批量 embed 大小（构建并发 1）
const RRF_K = 60;            // RRF 融合常数
const RECALL_N = 10;         // 每路召回数量
const VECTOR_QUERY_BUDGET_MS = 8000; // 查询向量分支软预算（开发集冻结值）
const BM25_CACHE_MAX = 5;

// ==================== 中文分词 ====================

// 简易中英文分词：英文按空格/标点，中文按单字 + 双字组合
function tokenize(text) {
    if (!text) return [];
    const tokens = [];
    const enWords = text.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || [];
    tokens.push(...enWords);
    const cnMatches = text.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const seg of cnMatches) {
        for (const ch of seg) tokens.push(ch);
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.substring(i, i + 2));
    }
    return tokens;
}

// ==================== BM25 ====================

class BM25Index {
    constructor(chunks, k1 = 1.5, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        this.chunks = chunks;
        this.docTokens = chunks.map(c => tokenize(c.text));
        this.docLen = this.docTokens.map(t => t.length);
        this.avgLen = this.docLen.length ? this.docLen.reduce((a, b) => a + b, 0) / this.docLen.length : 0;
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
            if (!(qt in idfCache)) idfCache[qt] = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
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

// BM25 LRU 缓存：键含 indexVersion，新旧版本不共用
const bm25Cache = new Map(); // userId:bookId:versionId -> BM25Index

function getBM25(userId, bookId, versionId) {
    const key = `${userId}:${bookId}:${versionId}`;
    if (bm25Cache.has(key)) {
        const idx = bm25Cache.get(key);
        bm25Cache.delete(key);
        bm25Cache.set(key, idx);
        return idx;
    }
    const rows = getDB().prepare(
        'SELECT id, chapter, text, chapter_id, chapter_ordinal, start_offset, end_offset, content_hash FROM rag_chunks WHERE user_id = ? AND book_id = ? AND index_version = ? ORDER BY chunk_index'
    ).all(userId, bookId, versionId);
    if (rows.length === 0) return null;
    const index = new BM25Index(rows);
    bm25Cache.set(key, index);
    if (bm25Cache.size > BM25_CACHE_MAX) bm25Cache.delete(bm25Cache.keys().next().value);
    return index;
}

function invalidateBM25Book(userId, bookId) {
    for (const k of [...bm25Cache.keys()]) {
        if (k.startsWith(`${userId}:${bookId}:`)) bm25Cache.delete(k);
    }
}

// ==================== 版本状态与并发控制 ====================

const buildTokens = new Map(); // userId:bookId -> { versionId, cancelled }
const versionUse = new Map();  // versionId -> 在途查询计数

const bkey = (u, b) => `${u}:${b}`;
const nowISO = () => new Date().toISOString();
const round4 = x => Number(Number(x).toFixed(4));

function abortError() { const e = new Error('已取消'); e.name = 'AbortError'; return e; }
function throwIfTerminated(signal, deadlineAt) {
    if (signal && signal.aborted) throw abortError();
    if (deadlineAt && Date.now() >= deadlineAt) { const e = new Error('请求总时限已到'); e.name = 'TimeoutError'; throw e; }
}

function getVersion(db, id) {
    return db.prepare('SELECT * FROM rag_index_versions WHERE id = ?').get(id) || null;
}

function getMeta(userId, bookId) {
    return getDB().prepare('SELECT * FROM rag_index_meta WHERE user_id = ? AND book_id = ?').get(userId, bookId) || null;
}

function getActiveVersion(userId, bookId) {
    const meta = getMeta(userId, bookId);
    if (!meta || !meta.active_version) return null;
    const v = getVersion(getDB(), meta.active_version);
    if (!v || v.user_id !== userId || v.book_id !== bookId || v.status !== 'ready') return null;
    return v;
}

/** 进程重启遗留 building → failed（中断），不自动重放付费任务 */
function recoverStaleBuilds() {
    const info = getDB().prepare(
        "UPDATE rag_index_versions SET status = 'failed', error_code = 'INTERRUPTED', finished_at = ? WHERE status = 'building'"
    ).run(nowISO());
    return info.changes;
}

/** 清理某版本的派生行：先删 rag_vec 对应 rowid，再删块（不留孤儿向量） */
function cleanupVersionDerived(db, versionId) {
    if (isVecAvailable()) {
        db.prepare('DELETE FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE index_version = ?)').run(versionId);
    }
    db.prepare('DELETE FROM rag_chunks WHERE index_version = ?').run(versionId);
}

/** 保留当前与前一个成功版本；其他版本派生行在使用计数归零后清理（版本元数据行保留作审计） */
function cleanupOldVersions(userId, bookId, keepIds) {
    const db = getDB();
    const rows = db.prepare('SELECT id FROM rag_index_versions WHERE user_id = ? AND book_id = ?').all(userId, bookId);
    const keep = new Set(keepIds.filter(Boolean));
    const tx = db.transaction(() => {
        for (const r of rows) {
            if (keep.has(r.id)) continue;
            if ((versionUse.get(r.id) || 0) > 0) continue;
            cleanupVersionDerived(db, r.id);
        }
    });
    tx();
}

// ==================== 索引构建 ====================

function vecBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * 为书籍建立版本化 RAG 索引。
 * @param {Object} opts { bookId, userId, content, embedder?, onProgress?, signal?, deadlineAt?, chunkerConfig? }
 * @returns {Object} { published, mode, chunkCount, vectorCount, indexVersion, warnings, embedError? }
 *   published=false 且存在旧 active 时表示重建失败但旧索引保留。
 */
async function indexBook(opts) {
    const { bookId, userId, embedder = null, onProgress, signal = null, deadlineAt = null } = opts;
    const db = getDB();
    const content = TU.normalizeText(opts.content);
    if (!content.trim()) {
        const e = new Error('书籍内容为空（只含空白），无法建立索引'); e.code = 'EMPTY_CONTENT'; throw e;
    }
    const hash = TU.contentHash(content);
    const cfg = { ...TU.DEFAULT_CHUNKER_CONFIG, ...(opts.chunkerConfig || {}) };
    const canVector = !!(embedder && isVecAvailable());
    const fingerprint = canVector ? embedding.embedFingerprint(embedder) : null;
    const versionId = crypto.randomUUID();

    // 短事务创建 building 版本；同书互斥由条件唯一索引保证（其他书不阻塞）
    try {
        db.prepare(`
            INSERT INTO rag_index_versions
                (id, user_id, book_id, content_hash, normalization_version, chunker_version, chunker_config_json,
                 embed_provider, embed_model, embed_fingerprint, dims, distance_metric, mode, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?)
        `).run(
            versionId, userId, bookId, hash, TU.NORMALIZATION_VERSION, TU.CHUNKER_VERSION, JSON.stringify(cfg),
            canVector ? embedder.providerId : null, canVector ? embedder.model : null, fingerprint,
            canVector ? embedder.dims : null, canVector ? 'l2' : null,
            canVector ? 'embedding+bm25' : 'bm25', nowISO()
        );
    } catch (e) {
        if (/UNIQUE/i.test(String(e.message))) {
            const err = new Error('该书已有索引正在构建，请等待完成'); err.code = 'INDEX_BUILD_RUNNING'; throw err;
        }
        throw e;
    }
    const token = { versionId, cancelled: false };
    buildTokens.set(bkey(userId, bookId), token);

    const warnings = [];
    const markFinished = (status, errorCode) => {
        db.prepare('UPDATE rag_index_versions SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = ?')
            .run(status, errorCode || null, nowISO(), versionId, 'building');
    };
    const releaseToken = () => {
        if (buildTokens.get(bkey(userId, bookId)) === token) buildTokens.delete(bkey(userId, bookId));
    };
    const assertBuildValid = () => {
        const v = getVersion(db, versionId);
        if (!v || v.status !== 'building' || token.cancelled) {
            const e = new Error('构建已失效（取消/删除/中断）'); e.code = 'BUILD_INVALIDATED'; throw e;
        }
        if (!db.prepare('SELECT 1 FROM books_meta WHERE id = ? AND user_id = ?').get(bookId, userId)) {
            const e = new Error('书籍已删除或不属于当前用户'); e.code = 'BUILD_INVALIDATED'; throw e;
        }
    };

    let chunks = [];
    const chunkIds = [];
    let vectorCount = 0;
    let embedError = null;

    try {
        throwIfTerminated(signal, deadlineAt);
        chunks = TU.chunkContent(content, cfg);
        onProgress && onProgress({ stage: 'chunked', total: chunks.length });

        // 写入新版本块（不先删 active 版本）
        const insertChunks = db.transaction(() => {
            assertBuildValid();
            const stmt = db.prepare(`
                INSERT INTO rag_chunks
                    (user_id, book_id, chunk_index, chapter, text, index_version, content_hash, chapter_id, chapter_ordinal, start_offset, end_offset)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const c of chunks) {
                const info = stmt.run(userId, bookId, c.index, c.chapterTitle, c.text, versionId, hash, c.chapterId, c.chapterOrdinal, c.start, c.end);
                chunkIds.push(Number(info.lastInsertRowid));
            }
            db.prepare('UPDATE rag_index_versions SET chunk_count = ? WHERE id = ?').run(chunks.length, versionId);
        });
        insertChunks();

        // 向量化：分批、并发 1；每批写入前复核版本/令牌/归属/块
        if (canVector) {
            try {
                onProgress && onProgress({ stage: 'embedding', total: chunks.length, done: 0 });
                const insertVec = db.prepare('INSERT INTO rag_vec (rowid, embedding) VALUES (?, ?)');
                for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
                    throwIfTerminated(signal, deadlineAt);
                    if (token.cancelled) throw abortError();
                    const batch = chunks.slice(i, i + EMBED_BATCH);
                    const vectors = await embedding.embedTexts(embedder, batch.map(c => c.text), { retries: 2, timeoutMs: 30000, signal, deadlineAt });
                    const batchIds = chunkIds.slice(i, i + batch.length);
                    const writeBatch = db.transaction(() => {
                        assertBuildValid();
                        const found = db.prepare(
                            `SELECT COUNT(*) c FROM rag_chunks WHERE index_version = ? AND user_id = ? AND book_id = ? AND id IN (${batchIds.map(() => '?').join(',')})`
                        ).get(versionId, userId, bookId, ...batchIds).c;
                        if (found !== batchIds.length) { const e = new Error('批次块缺失或不属于本版本'); e.code = 'BUILD_INVALIDATED'; throw e; }
                        for (let j = 0; j < vectors.length; j++) {
                            insertVec.run(BigInt(batchIds[j]), vecBuffer(vectors[j]));
                        }
                        vectorCount += vectors.length;
                        db.prepare('UPDATE rag_index_versions SET vector_count = ? WHERE id = ?').run(vectorCount, versionId);
                    });
                    writeBatch();
                    onProgress && onProgress({ stage: 'embedding', done: Math.min(i + EMBED_BATCH, chunks.length), total: chunks.length });
                }
            } catch (e) {
                if (e.name === 'AbortError' || e.code === 'BUILD_INVALIDATED') throw e;
                embedError = e.message;
                // 清理本版本已写入的向量（不影响其他版本）
                try {
                    if (isVecAvailable()) db.prepare('DELETE FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE index_version = ?)').run(versionId);
                } catch {}
                vectorCount = 0;
            }
        }

        throwIfTerminated(signal, deadlineAt);
        if (token.cancelled) throw abortError();

        // 发布前复核：hash、计数、locator（text 必须等于原文 slice）
        assertBuildValid();
        if (TU.contentHash(content) !== hash) { const e = new Error('构建期间书籍内容已变化'); e.code = 'CONTENT_CHANGED'; throw e; }
        if (typeof opts.getCurrentContentHash === 'function') {
            const currentHash = opts.getCurrentContentHash();
            if (!currentHash) { const e = new Error('书籍已删除或不可读'); e.code = 'BUILD_INVALIDATED'; throw e; }
            if (currentHash !== hash) { const e = new Error('构建期间书籍正文已变化，放弃发布'); e.code = 'CONTENT_CHANGED'; throw e; }
        }
        const stored = db.prepare('SELECT id, start_offset, end_offset, text FROM rag_chunks WHERE index_version = ? ORDER BY chunk_index').all(versionId);
        if (stored.length !== chunks.length) { const e = new Error('块计数不一致'); e.code = 'PUBLISH_CHECK_FAILED'; throw e; }
        for (const row of stored) {
            if (row.text !== content.slice(row.start_offset, row.end_offset)) {
                const e = new Error('块定位校验失败'); e.code = 'PUBLISH_CHECK_FAILED'; throw e;
            }
        }

        const prevActive = getActiveVersion(userId, bookId);
        const wantVector = canVector && !embedError && vectorCount === chunks.length;
        const finalMode = wantVector ? 'embedding+bm25' : 'bm25';

        if (canVector && embedError) {
            if (prevActive) {
                // 已有有效 active：保留旧版本，新构建标 failed，不静默替换
                markFinished('failed', 'EMBED_FAILED');
                cleanupVersionDerived(db, versionId);
                warnings.push({ code: 'EMBED_FAILED', message: `向量化失败，保留旧索引：${embedError}`, retryable: true });
                releaseToken();
                return { published: false, mode: prevActive.mode, chunkCount: prevActive.chunk_count, vectorCount: prevActive.vector_count, indexVersion: prevActive.id, warnings, embedError };
            }
            // 首次建库且块完整：发布 BM25 版本并明确警告
            warnings.push({ code: 'EMBED_FAILED', message: `向量化失败，已降级为纯 BM25 索引：${embedError}`, retryable: true });
        }

        // 发布短事务：条件更新确认仍 building → ready，原子切换 active_version 与摘要
        const publish = db.transaction(() => {
            assertBuildValid();
            const info = db.prepare(
                "UPDATE rag_index_versions SET status = 'ready', mode = ?, vector_count = ?, finished_at = ? WHERE id = ? AND status = 'building'"
            ).run(finalMode, wantVector ? vectorCount : 0, nowISO(), versionId);
            if (info.changes !== 1) { const e = new Error('发布条件不满足（版本已失效）'); e.code = 'BUILD_INVALIDATED'; throw e; }
            if (prevActive && prevActive.id !== versionId) {
                db.prepare("UPDATE rag_index_versions SET status = 'retired' WHERE id = ? AND status = 'ready'").run(prevActive.id);
            }
            db.prepare(`
                INSERT INTO rag_index_meta (user_id, book_id, mode, embed_provider, embed_model, dims, chunk_count, indexed_at, active_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, book_id) DO UPDATE SET
                    mode = excluded.mode, embed_provider = excluded.embed_provider, embed_model = excluded.embed_model,
                    dims = excluded.dims, chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at, active_version = excluded.active_version
            `).run(
                userId, bookId, finalMode,
                wantVector ? embedder.providerId : null, wantVector ? embedder.model : null,
                wantVector ? embedder.dims : null, chunks.length, nowISO(), versionId
            );
        });
        publish();
        releaseToken();
        cleanupOldVersions(userId, bookId, [versionId, prevActive && prevActive.id]);
        onProgress && onProgress({ stage: 'done', mode: finalMode, chunkCount: chunks.length });
        return { published: true, mode: finalMode, chunkCount: chunks.length, vectorCount: wantVector ? vectorCount : 0, indexVersion: versionId, warnings, ...(embedError ? { embedError } : {}) };
    } catch (e) {
        releaseToken();
        const cancelled = e.name === 'AbortError' || token.cancelled || e.code === 'BUILD_INVALIDATED';
        const status = cancelled ? 'cancelled' : 'failed';
        try {
            markFinished(status, e.code || (cancelled ? 'CANCELLED' : 'BUILD_FAILED'));
            cleanupVersionDerived(db, versionId);
        } catch {}
        if (e.code === 'EMPTY_CONTENT' || e.code === 'INDEX_BUILD_RUNNING') throw e;
        if (cancelled) {
            // 取消/失效：保留旧 active，抛出可识别终止
            if (e.name === 'AbortError') throw e;
            const err = new Error(e.message); err.code = e.code || 'CANCELLED'; throw err;
        }
        const err = new Error(`索引构建失败: ${e.message}`); err.code = e.code || 'BUILD_FAILED'; throw err;
    }
}

// ==================== 检索 ====================

function toCandidate(row, bookId, method, rank, score) {
    return {
        bookId,
        contentHash: row.content_hash || null,
        chunkId: row.id,
        chapter: row.chapter_id ? { id: row.chapter_id, ordinal: row.chapter_ordinal, title: row.chapter } : null,
        text: row.text,
        locator: (row.start_offset != null && row.end_offset != null && row.content_hash)
            ? { contentHash: row.content_hash, start: row.start_offset, end: row.end_offset }
            : null,
        method, rank, score
    };
}

/** 向量 KNN：限定 user+book+index_version 的 rowid 集合 */
async function vectorRecall(userId, bookId, version, embedder, query, topN, signal) {
    const [qVec] = await embedding.embedTexts(embedder, [query], { retries: 0, timeoutMs: VECTOR_QUERY_BUDGET_MS + 2000, signal });
    const rows = getDB().prepare(`
        SELECT v.rowid AS id, v.distance AS distance
        FROM rag_vec v
        WHERE v.embedding MATCH ?
          AND v.rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ? AND index_version = ?)
          AND k = ?
        ORDER BY v.distance
    `).all(vecBuffer(qVec), userId, bookId, version.id, topN);
    if (rows.length === 0) return [];
    const ids = rows.map(r => Number(r.id));
    const chunkRows = getDB().prepare(
        `SELECT id, chapter, text, chapter_id, chapter_ordinal, start_offset, end_offset, content_hash FROM rag_chunks WHERE index_version = ? AND id IN (${ids.map(() => '?').join(',')})`
    ).all(version.id, ...ids);
    const byId = new Map(chunkRows.map(r => [r.id, r]));
    return rows.map(r => ({ chunk: byId.get(Number(r.id)), distance: r.distance })).filter(x => x.chunk);
}

function bm25Recall(userId, bookId, version, query, topN) {
    const index = getBM25(userId, bookId, version.id);
    if (!index) return [];
    return index.search(query, topN);
}

/** RRF 融合：按块 ID 去重；保留原评分类型（hybrid→rrf，单路→原生分） */
function fuseResults(vecHits, bm25Hits, bookId, topK) {
    const map = new Map();
    const add = (list, method) => {
        list.forEach((h, rank) => {
            const e = map.get(h.chunk.id) || { chunk: h.chunk, rrf: 0, methods: [], bm25Score: null, distance: null };
            e.rrf += 1 / (RRF_K + rank + 1);
            e.methods.push(method);
            if (method === 'bm25') e.bm25Score = h.score; else e.distance = h.distance;
            map.set(h.chunk.id, e);
        });
    };
    if (bm25Hits) add(bm25Hits, 'bm25');
    if (vecHits) add(vecHits, 'vector');
    return [...map.values()]
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, topK)
        .map((e, i) => {
            const method = e.methods.length > 1 ? 'hybrid' : e.methods[0];
            const score = method === 'hybrid' ? { kind: 'rrf', value: round4(e.rrf) }
                : method === 'bm25' ? { kind: 'bm25', value: round4(e.bm25Score) }
                : { kind: 'vector_distance', value: e.distance };
            return toCandidate(e.chunk, bookId, method, i + 1, score);
        });
}

/** 等待向量分支：软预算超时→降级；外部取消/总时限→终止异常 */
function awaitVectorBranch(promise, { softMs, signal, deadlineAt, branchController }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let softTimer = null;
        let deadlineTimer = null;
        const cleanup = () => {
            clearTimeout(softTimer);
            clearTimeout(deadlineTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        const settle = (fn, val) => { if (!settled) { settled = true; cleanup(); fn(val); } };
        const onAbort = () => { branchController.abort(); settle(reject, abortError()); };
        if (signal && signal.aborted) return onAbort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        softTimer = setTimeout(() => {
            branchController.abort();
            const e = new Error('向量查询超出分支预算'); e.code = 'VECTOR_TIMEOUT';
            settle(reject, e);
        }, softMs);
        if (deadlineAt) {
            const remain = deadlineAt - Date.now();
            if (remain <= 0) {
                branchController.abort();
                const e = new Error('请求总时限已到'); e.name = 'TimeoutError';
                return settle(reject, e);
            }
            deadlineTimer = setTimeout(() => {
                branchController.abort();
                const e = new Error('请求总时限已到'); e.name = 'TimeoutError';
                settle(reject, e);
            }, remain);
        }
        promise.then(
            v => settle(resolve, v),
            e => settle(reject, e)
        );
    });
}

/**
 * 混合检索主入口（SC-1.1 §6.2 RetrievalResult）。
 * @param {Object} opts { signal, deadlineAt, expectedContentHash, rerank, reranker, expandAdjacent, content }
 */
async function retrieveDetailed(userId, bookId, query, topK = 5, opts = {}) {
    const t0 = Date.now();
    const diagnostics = { indexVersion: null, paths: [], warnings: [], elapsedMs: 0 };
    const result = { status: 'unavailable', candidates: [], diagnostics, error: null };
    const unavail = (code, message) => {
        result.error = { code, message, retryable: false };
        diagnostics.elapsedMs = Date.now() - t0;
        return result;
    };

    const meta = getMeta(userId, bookId);
    if (!meta) return unavail('INDEX_UNAVAILABLE', '本书尚未建立索引');
    if (!meta.active_version) return unavail('INDEX_LEGACY', '旧版索引缺少定位信息，需要重建后才能检索');
    const version = getVersion(getDB(), meta.active_version);
    if (!version || version.user_id !== userId || version.book_id !== bookId || version.status !== 'ready') {
        return unavail('INDEX_UNAVAILABLE', '索引版本不可用');
    }
    if (opts.expectedContentHash && opts.expectedContentHash !== version.content_hash) {
        return unavail('INDEX_STALE', '书籍内容已变化，索引与当前原文不一致，请重建索引');
    }
    diagnostics.indexVersion = version.id;

    // 查询快照：固定版本 + 使用计数（finally 释放；网络等待期间不持有数据库事务）
    versionUse.set(version.id, (versionUse.get(version.id) || 0) + 1);
    try {
        throwIfTerminated(opts.signal, opts.deadlineAt);

        // 向量分支：先启动网络请求，再立即执行本地 BM25
        let vecPromise = null;
        const branchController = new AbortController();
        if (version.mode === 'embedding+bm25' && isVecAvailable()) {
            const embedder = embedding.resolveEmbedder(userId, version.embed_provider);
            if (!embedder) {
                diagnostics.paths.push({ method: 'vector', status: 'skipped', code: 'VECTOR_UNAVAILABLE' });
                diagnostics.warnings.push({ code: 'VECTOR_UNAVAILABLE', message: 'Embedding 配置不可用，本次使用 BM25', retryable: true });
            } else if (embedding.embedFingerprint(embedder) !== version.embed_fingerprint) {
                diagnostics.paths.push({ method: 'vector', status: 'skipped', code: 'VECTOR_INCOMPATIBLE' });
                diagnostics.warnings.push({ code: 'VECTOR_INCOMPATIBLE', message: 'Embedding 端点/模型已变更，与建库向量不兼容，本次使用 BM25', retryable: false });
            } else {
                vecPromise = vectorRecall(userId, bookId, version, embedder, query, RECALL_N, branchController.signal);
            }
        } else {
            diagnostics.paths.push({ method: 'vector', status: 'skipped', code: version.mode === 'bm25' ? 'BM25_ONLY' : 'VEC_EXTENSION_UNAVAILABLE' });
        }

        // 本地 BM25（同步 CPU 工作，不宣称真正并行 CPU 计算）
        let bm25Hits = null;
        try {
            bm25Hits = bm25Recall(userId, bookId, version, query, RECALL_N);
            diagnostics.paths.push({ method: 'bm25', status: 'ok', code: null });
        } catch (e) {
            diagnostics.paths.push({ method: 'bm25', status: 'error', code: 'BM25_FAILED' });
            diagnostics.warnings.push({ code: 'BM25_FAILED', message: e.message, retryable: true });
        }

        let vecHits = null;
        let vecOk = false;
        if (vecPromise) {
            const softMs = Math.min(VECTOR_QUERY_BUDGET_MS, opts.deadlineAt ? Math.max(1, opts.deadlineAt - Date.now()) : VECTOR_QUERY_BUDGET_MS);
            try {
                vecHits = await awaitVectorBranch(vecPromise, { softMs, signal: opts.signal, deadlineAt: opts.deadlineAt, branchController });
                vecOk = true;
                diagnostics.paths.push({ method: 'vector', status: 'ok', code: null });
            } catch (e) {
                if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e; // 取消/总时限：终止，不当普通降级
                const code = e.code === 'VECTOR_TIMEOUT' ? 'VECTOR_TIMEOUT' : 'VECTOR_FAILED';
                diagnostics.paths.push({ method: 'vector', status: 'error', code });
                diagnostics.warnings.push({ code, message: e.message, retryable: true });
            }
        }

        const fused = fuseResults(vecOk ? vecHits : null, bm25Hits, bookId, topK);
        let candidates = fused;

        // 可选重排：失败保留原排序并记 warning
        const reranker = opts.rerank === false ? null : (opts.reranker || rerank.resolveReranker(userId));
        if (reranker && candidates.length > 1) {
            const fuseN = Math.max(topK, reranker.topN);
            const pool = fuseResults(vecOk ? vecHits : null, bm25Hits, bookId, fuseN);
            try {
                const ranked = await rerank.rerankDocuments(reranker, query, pool.map(c => c.text), { topN: topK, signal: opts.signal });
                candidates = ranked.map(r => ({ ...pool[r.index], score: { kind: 'rerank', value: r.score } }));
                diagnostics.paths.push({ method: 'rerank', status: 'ok', code: null });
                diagnostics.rerank = { applied: true, model: reranker.model };
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                diagnostics.paths.push({ method: 'rerank', status: 'error', code: 'RERANK_FAILED' });
                diagnostics.warnings.push({ code: 'RERANK_FAILED', message: e.message, retryable: true });
                diagnostics.rerank = { applied: false, error: e.message };
                candidates = pool.slice(0, topK);
            }
        } else {
            candidates = candidates.slice(0, topK);
        }

        // P3 邻接扩展（可选；需要调用方提供规范原文）
        if (opts.expandAdjacent && opts.content && candidates.length) {
            candidates = expandAdjacentRanges(candidates, opts.content, opts.expandCap || 1500);
            diagnostics.expansion = { applied: true, cap: opts.expandCap || 1500 };
        }

        result.candidates = candidates;
        if (candidates.length > 0) {
            result.status = 'ok';
        } else if (bm25Hits !== null || vecOk) {
            result.status = 'empty';
        } else {
            result.status = 'error';
            result.error = { code: 'RETRIEVAL_FAILED', message: '检索路径均失败，无可用结果', retryable: true };
        }
        diagnostics.elapsedMs = Date.now() - t0;
        return result;
    } finally {
        const c = (versionUse.get(version.id) || 1) - 1;
        if (c <= 0) versionUse.delete(version.id); else versionUse.set(version.id, c);
    }
}

/**
 * P3 邻接/父范围扩展：子块召回后在同章节内扩展到相邻段落边界，合并重叠区间；
 * 每证据上限 cap 码元；返回真实连续原文区间（不拼接不连续片段）。
 */
function expandAdjacentRanges(candidates, content, cap = 1500) {
    const chapters = TU.parseChapters(content);
    const paragraphStart = (pos, floor) => {
        // 向前找最近空行边界（段落起点）
        let i = pos;
        while (i > floor) {
            const prevNl = content.lastIndexOf('\n', i - 1);
            if (prevNl < floor) return floor;
            const lineStart = content.lastIndexOf('\n', prevNl - 1) + 1;
            const line = content.slice(Math.max(lineStart, floor), prevNl);
            if (!line.trim()) return prevNl + 1;
            i = lineStart;
            if (i <= floor) return floor;
        }
        return floor;
    };
    const paragraphEnd = (pos, ceil) => {
        let i = pos;
        while (i < ceil) {
            const nl = content.indexOf('\n', i);
            if (nl === -1 || nl >= ceil) return ceil;
            const line = content.slice(i, nl);
            if (!line.trim()) return i;
            i = nl + 1;
        }
        return ceil;
    };
    const ranges = [];
    for (const c of candidates) {
        if (!c.locator) { ranges.push({ s: null, e: null, c, chId: null }); continue; }
        const ch = chapters.find(x => c.locator.start >= x.start && c.locator.end <= x.end);
        const floor = ch ? ch.start : 0;
        const ceil = ch ? ch.end : content.length;
        let s = paragraphStart(c.locator.start, floor);
        let e = paragraphEnd(c.locator.end, ceil);
        if (e - s > cap) {
            // 以原命中为中心裁剪到 cap
            const center = Math.floor((c.locator.start + c.locator.end) / 2);
            s = Math.max(floor, center - Math.floor(cap / 2));
            e = Math.min(ceil, s + cap);
            s = Math.max(floor, e - cap);
        }
        const safe = TU.sliceAtSafeBoundary(content, s, e);
        ranges.push({ s: safe.start, e: safe.end, c, chId: ch ? ch.id : null });
    }
    // 合并重叠区间（仅同章节内；保留首个候选的方法/评分来源）
    const located = ranges.filter(r => r.s !== null).sort((a, b) => a.s - b.s);
    const merged = [];
    for (const r of located) {
        const last = merged[merged.length - 1];
        if (last && r.s <= last.e && r.chId === last.chId) {
            last.e = Math.max(last.e, r.e);
            last.items.push(r.c);
        } else {
            merged.push({ s: r.s, e: r.e, chId: r.chId, items: [r.c] });
        }
    }
    const out = [];
    for (const m of merged) {
        const safe = TU.sliceAtSafeBoundary(content, m.s, m.e);
        const first = m.items[0];
        out.push({
            ...first,
            text: safe.text,
            locator: { contentHash: first.contentHash || (first.locator && first.locator.contentHash), start: safe.start, end: safe.end },
            chunkId: first.chunkId,
            expandedFrom: m.items.map(x => x.chunkId)
        });
    }
    // 无 locator 的候选原样保留
    for (const r of ranges) if (r.s === null) out.push(r.c);
    return out.slice(0, candidates.length);
}

/** 兼容封装：返回候选数组 */
async function retrieveAsync(userId, bookId, query, topK = 5, opts = {}) {
    const { candidates } = await retrieveDetailed(userId, bookId, query, topK, opts);
    return candidates;
}

/** 同步纯 BM25（供不便 async 的调用方；固定 active 版本） */
function retrieve(userId, bookId, query, topK = 5) {
    const version = getActiveVersion(userId, bookId);
    if (!version) return [];
    return bm25Recall(userId, bookId, version, query, topK)
        .map((h, i) => toCandidate(h.chunk, bookId, 'bm25', i + 1, { kind: 'bm25', value: round4(h.score) }));
}

// ==================== 状态与删除 ====================

/**
 * 索引状态视图（RAG方案 §5.4）。
 * @param {string|null} currentContentHash 服务端读取的当前规范文本 hash（用于 usable 判定）
 */
function getIndexStatus(userId, bookId, currentContentHash = null) {
    const db = getDB();
    const view = { usable: false, active: null, build: null, rebuildRequired: false };
    const meta = getMeta(userId, bookId);
    const building = db.prepare(
        "SELECT * FROM rag_index_versions WHERE user_id = ? AND book_id = ? AND status = 'building' ORDER BY created_at DESC LIMIT 1"
    ).get(userId, bookId);
    if (building) {
        view.build = { indexVersion: building.id, state: 'building', processedChunks: building.vector_count || 0, totalChunks: building.chunk_count || 0, error: null };
    } else {
        const lastFailed = db.prepare(
            "SELECT * FROM rag_index_versions WHERE user_id = ? AND book_id = ? AND status IN ('failed', 'cancelled') ORDER BY finished_at DESC LIMIT 1"
        ).get(userId, bookId);
        if (lastFailed) {
            view.build = { indexVersion: lastFailed.id, state: lastFailed.status, processedChunks: lastFailed.vector_count || 0, totalChunks: lastFailed.chunk_count || 0, error: lastFailed.error_code };
        }
    }
    if (!meta) return view;
    if (!meta.active_version) {
        view.rebuildRequired = true; // 旧版索引：有行但无定位
        return view;
    }
    const v = getVersion(db, meta.active_version);
    if (!v || v.status !== 'ready' || v.user_id !== userId || v.book_id !== bookId) {
        view.rebuildRequired = true;
        return view;
    }
    view.active = { indexVersion: v.id, contentHash: v.content_hash, mode: v.mode, chunkCount: v.chunk_count, vectorCount: v.vector_count };
    if (currentContentHash) {
        view.usable = currentContentHash === v.content_hash;
        view.rebuildRequired = !view.usable;
    } else {
        view.usable = true;
    }
    return view;
}

/** 删除某书全部索引（用户主动）：先作废构建令牌，再按用户+书清理派生行 */
function deleteIndex(userId, bookId) {
    const token = buildTokens.get(bkey(userId, bookId));
    if (token) token.cancelled = true;
    const db = getDB();
    const tx = db.transaction(() => {
        if (isVecAvailable()) {
            db.prepare('DELETE FROM rag_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE user_id = ? AND book_id = ?)').run(userId, bookId);
        }
        db.prepare('DELETE FROM rag_chunks WHERE user_id = ? AND book_id = ?').run(userId, bookId);
        db.prepare('DELETE FROM rag_index_versions WHERE user_id = ? AND book_id = ?').run(userId, bookId);
        db.prepare('DELETE FROM rag_index_meta WHERE user_id = ? AND book_id = ?').run(userId, bookId);
    });
    tx();
    invalidateBM25Book(userId, bookId);
    // 旧版 JSON 索引文件（用户主动删除索引时顺带清理）
    try {
        const legacy = path.join(LEGACY_RAG_DIR, userId, `${bookId}.json`);
        if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    } catch {}
}

module.exports = {
    tokenize,
    indexBook,
    retrieve,
    retrieveAsync,
    retrieveDetailed,
    getIndexStatus,
    deleteIndex,
    recoverStaleBuilds,
    expandAdjacentRanges,
    VECTOR_QUERY_BUDGET_MS,
    _versionUse: versionUse
};