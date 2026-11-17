/**
 * 工具：getChapterInfo — 获取指定章节开头文本（规范章节 + 真实 locator）
 * 支持服务端 chapterId / 序号 / 标题关键词；标题匹配多章返回歧义信息，不任取第一章。
 * 长章截取标 truncated 且坐标与 text 一致，不把预览叫作摘要。
 */
const TU = require('../text-utils');
const TR = require('./tool-result');

const PREVIEW_CHARS = 1500;

module.exports = {
    name: 'getChapterInfo',
    description: '获取书中指定章节的开头原文。可通过章节标题关键词、章节序号（从1开始）或章节ID定位。',
    parameters: {
        type: 'object',
        properties: {
            chapterTitle: { type: 'string', description: '章节标题关键词' },
            chapterIndex: { type: 'integer', description: '章节序号（从1开始）' },
            chapterId: { type: 'string', description: '服务端章节ID（如 ch-2-123）' }
        }
    },
    async execute(args, ctx) {
        const content = ctx.content || '';
        const chapters = ctx.chapters || TU.chapterDTOs(content);
        let target = null;
        if (args.chapterId) {
            target = chapters.find(c => c.id === args.chapterId) || null;
        } else if (args.chapterIndex != null) {
            target = chapters[args.chapterIndex - 1] || null;
        } else if (args.chapterTitle) {
            const matches = chapters.filter(c => c.title.includes(args.chapterTitle));
            if (matches.length > 1) {
                return TR.empty({
                    ambiguous: true,
                    matches: matches.map(c => ({ id: c.id, ordinal: c.ordinal, title: c.title })),
                    totalChapters: chapters.length,
                    message: '标题匹配多个章节，请用 chapterIndex 或 chapterId 指定具体章节'
                });
            }
            target = matches[0] || chapters.find(c => content.slice(c.start, c.end).includes(args.chapterTitle)) || null;
        }
        if (!target) return TR.empty({ totalChapters: chapters.length, message: '未找到匹配章节' });
        const full = content.slice(target.start, target.end);
        let text = full;
        let end = target.end;
        let truncated = false;
        if (full.length > PREVIEW_CHARS) {
            const safe = TU.sliceAtSafeBoundary(full, 0, PREVIEW_CHARS);
            text = safe.text;
            end = target.start + safe.end;
            truncated = true;
        }
        const result = TR.ok(
            [TR.candidate({
                bookId: ctx.bookId, contentHash: ctx.contentHash || null,
                chapter: { id: target.id, ordinal: target.ordinal, title: target.title },
                text,
                locator: ctx.contentHash ? { contentHash: ctx.contentHash, start: target.start, end } : null,
                method: 'chapter', rank: 1
            })],
            { title: target.title, chapterId: target.id, totalChapters: chapters.length, length: full.length, truncated }
        );
        result.truncated = truncated;
        return result;
    }
};