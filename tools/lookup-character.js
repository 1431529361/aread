/**
 * 工具：lookupCharacter — 查找人物出场片段（统一 ToolResult）
 * returnedOccurrences 仅表示本次返回数，不冒充全书总次数；保留原文换行。
 */
const TR = require('./tool-result');

module.exports = {
    name: 'lookupCharacter',
    description: '在书中查找某个人物/角色名的所有出现位置及上下文片段，用于分析人物形象、关系或剧情线。',
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
        const candidates = [];
        let pos = 0;
        const MAX_HITS = 6;
        while ((pos = content.indexOf(charName, pos)) !== -1 && candidates.length < MAX_HITS) {
            const start = Math.max(0, pos - 80);
            const end = Math.min(content.length, pos + charName.length + 120);
            candidates.push(TR.candidate({
                bookId: ctx.bookId, chapter: null,
                text: content.substring(start, end), method: 'character'
            }));
            pos += charName.length;
        }
        if (!candidates.length) return TR.empty({ name: charName, returnedOccurrences: 0 });
        return TR.ok(candidates, { name: charName, returnedOccurrences: candidates.length });
    }
};