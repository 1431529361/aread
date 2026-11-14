/**
 * 工具：searchInBook — 全书检索（RAG 混合检索 + 可选重排 + 全文子串兜底）
 * 返回统一 ToolResult；原文放 candidates，来源按本次实际路径标注。
 */
const rag = require('../rag');
const TR = require('./tool-result');

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
        const { hits, diagnostics } = await rag.retrieveDetailed(ctx.userId, ctx.bookId, query, 5);
        if (hits.length === 0) {
            const idx = ctx.content ? ctx.content.indexOf(query) : -1;
            if (idx >= 0) {
                const snippet = ctx.content.substring(Math.max(0, idx - 200), idx + 800);
                return TR.ok([TR.candidate({ bookId: ctx.bookId, chapter: null, text: snippet, method: 'fulltext' })], { source: 'fulltext' }, diagnostics);
            }
            return TR.empty({ source: 'empty', message: '未在书中检索到相关内容，建议基于选中文本回答' }, diagnostics);
        }
        const okMethods = diagnostics.paths.filter(p => p.status === 'ok').map(p => p.method);
        const hasVec = okMethods.includes('vector');
        const hasBm25 = okMethods.includes('bm25');
        let source = hasVec && hasBm25 ? 'hybrid(embedding+bm25)' : (hasVec ? 'vector' : 'bm25');
        if (okMethods.includes('rerank')) source += '+rerank';
        const candidates = hits.map((h, i) => TR.candidate({
            bookId: ctx.bookId, chapter: h.chapter, text: h.text,
            method: h.method || source, rank: i + 1, score: { kind: 'rrf', value: h.score }
        }));
        const { candidates: trimmed, truncated } = TR.truncateCandidates(candidates, 600, 10);
        const result = TR.ok(trimmed, { source }, diagnostics);
        result.truncated = truncated;
        if (diagnostics.rerank && diagnostics.rerank.applied === false) {
            result.data.rerankWarning = '重排失败，已保留融合原排序';
        }
        return result;
    }
};