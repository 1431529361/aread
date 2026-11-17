/**
 * 工具：lookupCharacter — 查找人物出场片段（规范文本多处片段 + 真实 locator）
 * returnedOccurrences 仅表示本次返回数，不冒充全书总次数；保留原文换行。
 */
const TU = require('../text-utils');
const TR = require('./tool-result');

const MAX_HITS = 6;

module.exports = {
    name: 'lookupCharacter',
    description: '在书中查找某个人物/角色名的出现位置及上下文片段，用于分析人物形象、关系或剧情线。',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '人物姓名或称呼' }
        },
        required: ['name']
    },
    async execute(args, ctx) {
        const charName = args.name || '';
        const content = ctx.content || '';
        if (!charName.trim() || !content) return TR.empty({ name: charName, returnedOccurrences: 0 });
        const chapters = ctx.chapters || TU.chapterDTOs(content);
        const chapterAt = (pos) => {
            const ch = chapters.find(c => pos >= c.start && pos < c.end);
            return ch ? { id: ch.id, ordinal: ch.ordinal, title: ch.title } : null;
        };
        const candidates = [];
        let pos = 0;
        while (candidates.length < MAX_HITS) {
            const idx = content.indexOf(charName, pos);
            if (idx === -1) break;
            const safe = TU.sliceAtSafeBoundary(content, Math.max(0, idx - 80), Math.min(content.length, idx + charName.length + 120));
            candidates.push(TR.candidate({
                bookId: ctx.bookId, contentHash: ctx.contentHash || null,
                chapter: chapterAt(idx), text: safe.text,
                locator: ctx.contentHash ? { contentHash: ctx.contentHash, start: safe.start, end: safe.end } : null,
                method: 'character', rank: candidates.length + 1
            }));
            pos = idx + charName.length;
        }
        if (!candidates.length) return TR.empty({ name: charName, returnedOccurrences: 0 });
        return TR.ok(candidates, { name: charName, returnedOccurrences: candidates.length });
    }
};