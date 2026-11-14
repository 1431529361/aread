/**
 * 工具：getChapterInfo — 获取指定章节开头文本（统一 ToolResult）
 */
const { splitChapters, truncate } = require('../text-utils');
const TR = require('./tool-result');

module.exports = {
    name: 'getChapterInfo',
    description: '获取书中指定章节的内容摘要与开头文本。可通过章节标题关键词或章节序号（从1开始）定位。',
    parameters: {
        type: 'object',
        properties: {
            chapterTitle: { type: 'string', description: '章节标题关键词' },
            chapterIndex: { type: 'integer', description: '章节序号（从1开始）' }
        }
    },
    async execute(args, ctx) {
        const chapters = splitChapters(ctx.content || '');
        let target = null;
        if (args.chapterIndex != null) {
            target = chapters[args.chapterIndex - 1];
        } else if (args.chapterTitle) {
            target = chapters.find(c => c.title.includes(args.chapterTitle)) ||
                    chapters.find(c => c.text.includes(args.chapterTitle));
        }
        if (!target) return TR.empty({ totalChapters: chapters.length, message: '未找到匹配章节' });
        const preview = truncate(target.text, 1500);
        const result = TR.ok(
            [TR.candidate({ bookId: ctx.bookId, chapter: target.title, text: preview, method: 'chapter' })],
            { title: target.title, totalChapters: chapters.length, length: target.text.length }
        );
        result.truncated = preview.length < target.text.length;
        return result;
    }
};