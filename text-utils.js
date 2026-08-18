/**
 * 文本处理工具（章节切分 / 截断）
 * - 从 agent.js 迁出，供 tools/ 与 orchestrator 共用，避免循环依赖
 * - 章节切分逻辑与前端 formatTextContent 对齐
 */

const MAX_TOOL_RESULT_CHARS = 3000; // 单次工具结果截断长度

const CHAPTER_RE = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

function splitChapters(content) {
    const paragraphs = content.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chapters = [];
    let current = null;
    for (const para of paragraphs) {
        if (CHAPTER_RE.test(para)) {
            if (current) chapters.push(current);
            current = { title: para.substring(0, 60), text: para + '\n' };
        } else if (current) {
            current.text += para + '\n';
        } else {
            current = { title: '前言', text: para + '\n' };
        }
    }
    if (current) chapters.push(current);
    if (chapters.length === 0) chapters.push({ title: '全文', text: content });
    return chapters;
}

function truncate(text, max = MAX_TOOL_RESULT_CHARS) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '\n...(内容已截断)' : text;
}

module.exports = { CHAPTER_RE, MAX_TOOL_RESULT_CHARS, splitChapters, truncate };
