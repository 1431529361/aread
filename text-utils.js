/**
 * 规范文本与定位（P1b R1，SC-1.1 §6.1 / RAG方案 §4）
 * - TXT 规范文本 v1：去开头 BOM、CRLF/CR→LF；不 trim、不合并空行、不做 Unicode 归一化
 * - contentHash = txt-v1:SHA256(UTF8(content))；偏移为 UTF-16 码元、半开区间 [start,end)
 * - 章节解析、范围分块、工具与阅读器共用同一套坐标；边界不切断代理对
 */
const crypto = require('crypto');

const MAX_TOOL_RESULT_CHARS = 3000;
const NORMALIZATION_VERSION = 'txt-v1';
const CHUNKER_VERSION = 'range-v1';
// P1b 起点为 500/750/100；P3 开发集消融选定 1200/1800/240（回收范围分块边界造成的召回回落，延迟不变）
const DEFAULT_CHUNKER_CONFIG = { targetSize: 1200, longThreshold: 1800, overlap: 240 };
const P1B_CHUNKER_CONFIG = { targetSize: 500, longThreshold: 750, overlap: 100 };

const CHAPTER_RE = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

function normalizeText(decodedText) {
    let s = String(decodedText ?? '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s.replace(/\r\n?/g, '\n');
}

function contentHash(content) {
    return `${NORMALIZATION_VERSION}:${crypto.createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex')}`;
}

function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

/** 若 i 落在代理对中间，移到对后一码元，保证边界不切断代理对 */
function safeBoundary(content, i) {
    if (i > 0 && i < content.length &&
        isHighSurrogate(content.charCodeAt(i - 1)) && isLowSurrogate(content.charCodeAt(i))) {
        return i + 1;
    }
    return i;
}

/** 按安全边界截取原文；返回 { start, end, text }，text 恒等于 content.slice(start,end) */
function sliceAtSafeBoundary(content, start, end) {
    const len = content.length;
    let s = Math.max(0, Math.min(len, Math.floor(start)));
    let e = Math.max(s, Math.min(len, Math.floor(end)));
    s = safeBoundary(content, s);
    e = Math.min(safeBoundary(content, e), len);
    if (e < s) e = s;
    return { start: s, end: e, text: content.slice(s, e) };
}

/**
 * 章节解析：扫描原始行，仅用行的 trim 副本判断标题，原文范围不裁剪。
 * 返回 [{ id, ordinal, title, start, end, synthetic }]；synthetic 标记合成结构标签（前言/全文），
 * 对外 API 输出时剥离该内部字段。只含空白的文档返回 []。
 */
function parseChapters(content) {
    if (!content || !content.trim()) return [];
    const lines = [];
    let pos = 0;
    while (pos <= content.length) {
        const nl = content.indexOf('\n', pos);
        const end = nl === -1 ? content.length : nl;
        lines.push({ start: pos, end, trimmed: content.slice(pos, end).trim() });
        if (nl === -1) break;
        pos = nl + 1;
    }
    const titleIdx = [];
    lines.forEach((l, i) => { if (l.trimmed && CHAPTER_RE.test(l.trimmed)) titleIdx.push(i); });

    const make = (ordinal, title, start, end, synthetic) =>
        ({ id: `ch-${ordinal}-${start}`, ordinal, title, start, end, synthetic });

    if (!titleIdx.length) return [make(1, '全文', 0, content.length, true)];

    const chapters = [];
    let ordinal = 0;
    const preEnd = lines[titleIdx[0]].start;
    if (content.slice(0, preEnd).trim()) {
        chapters.push(make(++ordinal, '前言', 0, preEnd, true));
    }
    for (let k = 0; k < titleIdx.length; k++) {
        const li = titleIdx[k];
        const start = lines[li].start;
        const end = k + 1 < titleIdx.length ? lines[titleIdx[k + 1]].start : content.length;
        chapters.push(make(++ordinal, lines[li].trimmed, start, end, false));
    }
    return chapters;
}

/** 对外章节 DTO（剥离内部 synthetic 字段） */
function chapterDTOs(content) {
    return parseChapters(content).map(({ id, ordinal, title, start, end }) => ({ id, ordinal, title, start, end }));
}

/** 章节范围内按段落（空行分隔的连续非空白行，含尾随空行）产出 [start,end) */
function* paragraphRanges(content, start, end) {
    let pStart = null;
    let pendingBlankStart = null;
    let i = start;
    while (i < end) {
        const nl = content.indexOf('\n', i);
        const lineEnd = nl === -1 || nl >= end ? end : nl + 1;
        const blank = !content.slice(i, Math.min(lineEnd, end)).trim();
        if (!blank) {
            if (pStart === null) pStart = pendingBlankStart !== null ? pendingBlankStart : i;
            pendingBlankStart = null;
        } else if (pStart !== null) {
            let j = lineEnd;
            while (j < end) {
                const nl2 = content.indexOf('\n', j);
                const le2 = nl2 === -1 || nl2 >= end ? end : nl2 + 1;
                if (content.slice(j, Math.min(le2, end)).trim()) break;
                j = le2;
            }
            yield [pStart, j];
            pStart = null;
            pendingBlankStart = null;
            i = j;
            continue;
        } else if (pendingBlankStart === null) {
            pendingBlankStart = i;
        }
        i = lineEnd;
    }
    if (pStart !== null) yield [pStart, end];
}

function pushChunk(content, s, e, ch, out) {
    const text = content.slice(s, e);
    if (!text.trim()) return;
    out.push({
        index: out.length,
        chapterId: ch.id, chapterOrdinal: ch.ordinal, chapterTitle: ch.title,
        start: s, end: e, text
    });
}

/** 刷新区间：≤longThreshold 保留整段；否则按 targetSize 长、overlap 重叠滑窗 */
function emitRange(content, s, e, ch, cfg, out) {
    if (e - s <= cfg.longThreshold) {
        pushChunk(content, s, e, ch, out);
        return;
    }
    let pos = s;
    while (pos < e) {
        let end = Math.min(safeBoundary(content, Math.min(pos + cfg.targetSize, e)), e);
        if (end <= pos) end = Math.min(pos + 1, e);
        pushChunk(content, pos, end, ch, out);
        if (end >= e) break;
        let next = safeBoundary(content, end - cfg.overlap);
        if (next <= pos) next = pos + 1;
        pos = next;
    }
}

/**
 * 范围分块（RAG方案 §4.3）：章节内按段落边界累计到 targetSize 刷新；
 * 块 text 严格等于规范原文 slice；不跨章节；末尾短块保留；非空白码元全覆盖。
 * @returns [{ index, chapterId, chapterOrdinal, chapterTitle, start, end, text }]
 */
function chunkContent(content, opts = {}) {
    const cfg = { ...DEFAULT_CHUNKER_CONFIG, ...opts };
    if (!(cfg.targetSize > 0 && cfg.longThreshold >= cfg.targetSize && cfg.overlap >= 0 && cfg.overlap < cfg.targetSize)) {
        throw new Error('非法分块参数');
    }
    const out = [];
    for (const ch of parseChapters(content)) {
        let accStart = null;
        let accEnd = null;
        const flush = () => {
            if (accStart === null) return;
            emitRange(content, accStart, accEnd, ch, cfg, out);
            accStart = accEnd = null;
        };
        for (const [ps, pe] of paragraphRanges(content, ch.start, ch.end)) {
            if (accStart === null) accStart = ps;
            accEnd = pe;
            if (accEnd - accStart >= cfg.targetSize) flush();
        }
        flush();
    }
    return out;
}

/** 旧接口兼容：编排器仍用 {title,text}，但章节表示与规范坐标一致 */
function splitChapters(content) {
    return parseChapters(content).map(ch => ({ title: ch.title, text: content.slice(ch.start, ch.end) }));
}

function truncate(text, max = MAX_TOOL_RESULT_CHARS) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '\n...(内容已截断)' : text;
}

module.exports = {
    CHAPTER_RE, MAX_TOOL_RESULT_CHARS,
    NORMALIZATION_VERSION, CHUNKER_VERSION, DEFAULT_CHUNKER_CONFIG, P1B_CHUNKER_CONFIG,
    normalizeText, contentHash, safeBoundary, sliceAtSafeBoundary,
    parseChapters, chapterDTOs, chunkContent,
    splitChapters, truncate
};