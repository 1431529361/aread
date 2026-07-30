/**
 * 工具：lookupCharacter — 查找人物出场位置及上下文片段
 */

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
        const contexts = [];
        let pos = 0;
        const MAX_HITS = 6;
        while ((pos = content.indexOf(charName, pos)) !== -1 && contexts.length < MAX_HITS) {
            const start = Math.max(0, pos - 80);
            const end = Math.min(content.length, pos + charName.length + 120);
            contexts.push({
                position: pos,
                snippet: content.substring(start, end).replace(/\n+/g, ' ')
            });
            pos += charName.length;
        }
        return {
            name: charName,
            occurrences: contexts.length,
            samples: contexts
        };
    }
};
