/**
 * 确定性人工测试样本（自编文本，无版权风险）。
 * 覆盖：章节结构、重复段落、无目录文本、跨用户同名书、含 HTML 的注入文本。
 */

const BOOK_A = `第一章 启程
林远出生在北方的小城，父亲是一名钟表匠。他从小喜欢听钟表齿轮的声音。
这是一段重复的段落，用于定位测试。
第二章 灯塔
海边有一座青色灯塔，守塔人叫老周。灯塔每晚点亮，为渔船指引方向。
第三章 秘密
林远在灯塔的地下室发现了一本蓝色封皮的航海日志，记录着三十年前的沉船事件。
这是一段重复的段落，用于定位测试。
第四章 归途
多年以后，林远回到小城，把航海日志交给了历史博物馆。
`;

const BOOK_B = `第一章 山村
苏梅在山村里教孩子们读书，教室里只有一块黑板。
第二章 洪水
夏天洪水冲毁了木桥，苏梅带孩子们绕山路去上学。
第三章 新桥
村民们集资修了一座石拱桥，苏梅在桥头刻下了孩子们的名字。
`;

// 无章节结构文本（触发纯滑动窗口兜底分块）
const NO_TOC_BOOK = `这是一本没有目录的测试书。${'段落内容甲。'.repeat(60)}
${'段落内容乙。'.repeat(60)}
结尾处有一个独特标记：紫水晶徽章。
`;

// 与 BOOK_A 同名但内容不同（跨用户同名书隔离样本）
const SAME_TITLE_DIFF_CONTENT = `第一章 另一本书
这本书虽然同名，但内容完全不同。主角叫赵铁柱，他在草原上放牧。
第二章 草原
赵铁柱的羊群里有一只领头的黑羊，名字叫乌云。
`;

// 含 HTML/脚本的文本（验证前端只渲染文字，不执行）
const HTML_INJECTION_TEXT = '正常文本<img src=x onerror="window.__p0_xss=1"><script>window.__p0_xss=2</script>结束';

// 记忆抽取注入样本（P2 新契约）：非法 kind 应被拒绝（不写入），合法候选正常入库；
// "__SOURCE_ID__" 由假模型服务替换为 prompt 中真实来源消息ID。
const MALICIOUS_EXTRACTION = JSON.stringify([
    { kind: 'preference', key: 'preference.answer_format', normalizedValue: 'bullets', content: '用户偏好分点回答', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 7 }, statementType: 'explicit', stability: 'stable', relation: 'independent' },
    { kind: '<img src=x onerror=window.__p0_xss=1>', key: 'fact.role', normalizedValue: '非法kind样本', content: '非法kind样本', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 7 }, statementType: 'explicit', stability: 'stable', relation: 'independent' },
    { kind: 'FACT', key: 'fact.role', normalizedValue: '大写kind样本', content: '大写kind样本', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 7 }, statementType: 'explicit', stability: 'stable', relation: 'independent' },
    { kind: 123, key: 'fact.role', normalizedValue: '数字kind样本', content: '数字kind样本', scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 7 }, statementType: 'explicit', stability: 'stable', relation: 'independent' },
    { kind: 'interest', key: 'interest.topic:xss', normalizedValue: 'xss', content: HTML_INJECTION_TEXT, scope: 'user', sourceMessageId: '__SOURCE_ID__', sourceRange: { start: 0, end: 7 }, statementType: 'explicit', stability: 'stable', relation: 'independent' }
]);

module.exports = {
    BOOK_A,
    BOOK_B,
    NO_TOC_BOOK,
    SAME_TITLE_DIFF_CONTENT,
    HTML_INJECTION_TEXT,
    MALICIOUS_EXTRACTION
};