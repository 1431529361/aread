/**
 * 工具：searchInBook — 在全书检索相关段落（RAG 混合检索 + 全文子串兜底）
 */

const rag = require('../rag');
const { truncate } = require('../text-utils');

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
        // 混合检索（向量 + BM25 双路召回 RRF 融合）；query 向量化由 rag 内部按建库 meta 自行解析
        const hits = await rag.retrieveAsync(ctx.userId, ctx.bookId, query, 5);
        if (hits.length === 0) {
            // 无 RAG 索引时，回退全文子串搜索
            const idx = ctx.content ? ctx.content.indexOf(query) : -1;
            if (idx >= 0) {
                return { source: 'fulltext', snippet: truncate(ctx.content.substring(Math.max(0, idx - 200), idx + 800)) };
            }
            return { source: 'empty', message: '未在书中检索到相关内容，建议基于选中文本回答' };
        }
        const status = rag.getIndexStatus(ctx.userId, ctx.bookId);
        return {
            source: status.mode === 'embedding+bm25' ? 'hybrid(embedding+bm25)' : 'bm25',
            results: hits.map(h => ({ chapter: h.chapter, score: h.score, text: truncate(h.text, 600) }))
        };
    }
};
