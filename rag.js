/**
 * RAG 检索增强模块
 * - 文本分块：章节边界优先 + 滑动窗口兜底
 * - 检索：BM25 关键词检索（默认，纯 JS 无依赖）+ 可选 Embedding 向量增强
 * - 持久化：JSON 文件落盘到 rag_index/<userId>/<bookId>.json
 */

const fs = require('fs');
const path = require('path');

const RAG_DIR = path.join(__dirname, 'rag_index');
const CHUNK_SIZE = 500;      // 每块最大字符数
const CHUNK_OVERLAP = 100;   // 滑动窗口重叠字符数

if (!fs.existsSync(RAG_DIR)) {
    fs.mkdirSync(RAG_DIR, { recursive: true });
}

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

// ==================== Embedding（可选增强） ====================

const EMBEDDING_ENDPOINTS = {
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    siliconflow: 'https://api.siliconflow.cn/v1/embeddings'
};
const EMBEDDING_MODELS = {
    zhipu: 'embedding-3',
    siliconflow: 'BAAI/bge-large-zh-v1.5'
};

async function embed(texts, apiKey, providerId) {
    const endpoint = EMBEDDING_ENDPOINTS[providerId];
    const model = EMBEDDING_MODELS[providerId];
    if (!endpoint || !model) throw new Error('当前提供商不支持 Embedding');
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error(`Embedding API 失败: ${resp.status}`);
    const data = await resp.json();
    // OpenAI 兼容：data.data[i].embedding
    return data.data.map(d => d.embedding);
}

function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ==================== 索引持久化 ====================

function indexFilePath(userId, bookId) {
    const userDir = path.join(RAG_DIR, userId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return path.join(userDir, `${bookId}.json`);
}

function saveIndex(userId, bookId, index) {
    fs.writeFileSync(indexFilePath(userId, bookId), JSON.stringify(index));
}

function loadIndex(userId, bookId) {
    const fp = indexFilePath(userId, bookId);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function deleteIndex(userId, bookId) {
    const fp = indexFilePath(userId, bookId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ==================== 对外接口 ====================

/**
 * 为书籍建立 RAG 索引
 * @param {Object} opts { bookId, userId, content, apiKey?, providerId?, onProgress? }
 * @returns {Object} 索引状态
 */
async function indexBook({ bookId, userId, content, apiKey, providerId, onProgress }) {
    const chunks = chunkText(content);
    onProgress && onProgress({ stage: 'chunked', total: chunks.length });

    // 尝试 Embedding 向量化
    let vectors = null;
    if (apiKey && providerId && EMBEDDING_ENDPOINTS[providerId]) {
        try {
            onProgress && onProgress({ stage: 'embedding' });
            // 分批 embed，避免单次请求过大
            const BATCH = 16;
            vectors = [];
            for (let i = 0; i < chunks.length; i += BATCH) {
                const batch = chunks.slice(i, i + BATCH).map(c => c.text);
                const vecs = await embed(batch, apiKey, providerId);
                vectors.push(...vecs);
                onProgress && onProgress({ stage: 'embedding', done: Math.min(i + BATCH, chunks.length), total: chunks.length });
            }
        } catch (e) {
            console.warn('Embedding 失败，回退到 BM25 关键词检索:', e.message);
            vectors = null;
        }
    }

    // BM25 索引始终建立（作为兜底与无 embedding 时的主检索）
    const bm25 = new BM25Index(chunks);
    const index = {
        bookId, userId,
        chunks,
        vectors,
        indexedAt: new Date().toISOString(),
        chunkCount: chunks.length,
        mode: vectors ? 'embedding+bm25' : 'bm25'
    };
    // 存 bm25 必要数据（重新构造较轻，这里存原始 chunks 即可，检索时重建）
    saveIndex(userId, bookId, index);
    onProgress && onProgress({ stage: 'done', mode: index.mode, chunkCount: chunks.length });
    return { mode: index.mode, chunkCount: chunks.length };
}

/**
 * 检索相关片段
 * @returns {Array<{ text, chapter, score }>} Top-K 片段
 */
function retrieve(userId, bookId, query, topK = 5) {
    const index = loadIndex(userId, bookId);
    if (!index || !index.chunks || index.chunks.length === 0) return [];

    // 优先 Embedding 向量检索
    if (index.vectors && index.vectors.length === index.chunks.length) {
        // 需要 query 向量，但此处若没 apiKey/provider 无法 embed query
        // 为保持检索可用，统一用 BM25（向量检索在 indexBook 时若已 embed，
        // 可在 retrieve 时传入 embedQueryFn 增强见 retrieveAsync）
    }

    // BM25 检索（默认主路径，对中文书籍召回稳定）
    const bm25 = new BM25Index(index.chunks);
    const hits = bm25.search(query, topK);
    return hits.map(h => ({ text: h.chunk.text, chapter: h.chunk.chapter, score: h.score }));
}

/**
 * 异步检索：支持 Embedding 向量召回（若提供 embedQueryFn）
 */
async function retrieveAsync(userId, bookId, query, topK = 5, embedQueryFn) {
    const index = loadIndex(userId, bookId);
    if (!index || !index.chunks || index.chunks.length === 0) return [];

    if (index.vectors && embedQueryFn) {
        try {
            const qVec = await embedQueryFn(query);
            const sims = index.vectors.map(v => cosineSim(qVec, v));
            const hits = sims
                .map((s, i) => ({ text: index.chunks[i].text, chapter: index.chunks[i].chapter, score: s }))
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);
            if (hits.length > 0) return hits;
        } catch (e) {
            console.warn('向量检索失败，回退 BM25:', e.message);
        }
    }
    // BM25 兜底
    return retrieve(userId, bookId, query, topK);
}

function getIndexStatus(userId, bookId) {
    const index = loadIndex(userId, bookId);
    if (!index) return { indexed: false };
    return {
        indexed: true,
        mode: index.mode,
        chunkCount: index.chunkCount,
        indexedAt: index.indexedAt
    };
}

module.exports = {
    chunkText,
    tokenize,
    indexBook,
    retrieve,
    retrieveAsync,
    getIndexStatus,
    deleteIndex,
    embed // 暴露给 agent.js 用于 query 向量化
};
