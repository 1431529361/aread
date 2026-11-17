/**
 * 工具：searchInBook — 全书检索（版本化 RAG + 可选重排 + 全文子串兜底）
 * 透传候选 locator/chunkId/contentHash；来源按本次实际路径标注；全文兜底返回真实位置（多处上限）。
 */
const rag = require('../rag');
const TU = require('../text-utils');
const TR = require('./tool-result');

const FULLTEXT_MAX_HITS = 3;

function chapterAt(ctx, pos) {
    const chapters = ctx.chapters || (ctx.content ? TU.chapterDTOs(ctx.content) : []);
    const ch = chapters.find(c => pos >= c.start && pos < c.end);
    return ch ? { id: ch.id, ordinal: ch.ordinal, title: ch.title } : null;
}

module.exports = {
    name: 'searchInBook',
    description: '在当前阅读的书籍全文中检索与查询最相关的段落（基于 RAG 向量/BM25 检索）。用于回答需要查阅书中其他部分、或超出选中文本范围的问题。',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: '检索查询词或问题' }
        },
        required: ['query']
    },
    async execute(args, ctx) {
        const query = args.query || '';
        const ret = await rag.retrieveDetailed(ctx.userId, ctx.bookId, query, 5, {
            signal: ctx.signal || null,
            deadlineAt: ctx.deadlineAt || null,
            expectedContentHash: ctx.contentHash || null
        });
        if (ret.status === 'error') {
            const r = TR.error(ret.error.code, ret.error.message);
            r.diagnostics = ret.diagnostics;
            return r;
        }
        if (ret.candidates.length === 0) {
            // 全文子串兜底：仅有意义的非空查询；按规范文本返回实际位置，重复命中返回多处（上限）
            const q = query.trim();
            if (q.length >= 2 && ctx.content) {
                const candidates = [];
                let pos = 0;
                while (candidates.length < FULLTEXT_MAX_HITS) {
                    const idx = ctx.content.indexOf(q, pos);
                    if (idx === -1) break;
                    const safe = TU.sliceAtSafeBoundary(ctx.content, Math.max(0, idx - 200), Math.min(ctx.content.length, idx + q.length + 600));
                    candidates.push(TR.candidate({
                        bookId: ctx.bookId, contentHash: ctx.contentHash || null,
                        chapter: chapterAt(ctx, safe.start), text: safe.text,
                        locator: ctx.contentHash ? { contentHash: ctx.contentHash, start: safe.start, end: safe.end } : null,
                        method: 'fulltext', rank: candidates.length + 1
                    }));
                    pos = idx + q.length;
                }
                if (candidates.length) return TR.ok(candidates, { source: 'fulltext' }, ret.diagnostics);
            }
            if (ret.status === 'unavailable') {
                const r = TR.unavailable(ret.error.code, ret.error.message, { source: 'unavailable' });
                r.diagnostics = ret.diagnostics;
                return r;
            }
            return TR.empty({ source: 'empty', message: '未在书中检索到相关内容，建议基于选中文本回答' }, ret.diagnostics);
        }
        const okMethods = ret.diagnostics.paths.filter(p => p.status === 'ok').map(p => p.method);
        const hasVec = okMethods.includes('vector');
        const hasBm25 = okMethods.includes('bm25');
        let source = hasVec && hasBm25 ? 'hybrid(embedding+bm25)' : (hasVec ? 'vector' : 'bm25');
        if (okMethods.includes('rerank')) source += '+rerank';
        const { candidates: trimmed, truncated } = TR.truncateCandidates(ret.candidates, 600, 10);
        const result = TR.ok(trimmed, { source, indexVersion: ret.diagnostics.indexVersion }, ret.diagnostics);
        result.truncated = truncated;
        if (ret.diagnostics.rerank && ret.diagnostics.rerank.applied === false) {
            result.data.rerankWarning = '重排失败，已保留融合原排序';
        }
        return result;
    }
};