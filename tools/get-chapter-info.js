/**
 * 工具：getChapterInfo — 获取指定章节的内容摘要与开头文本
 */

const { splitChapters, truncate } = require('../text-utils');

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
        if (!target) return { error: '未找到匹配章节', totalChapters: chapters.length };
        return {
            title: target.title,
            totalChapters: chapters.length,
            preview: truncate(target.text, 1500),
            length: target.text.length
        };
    }
};
