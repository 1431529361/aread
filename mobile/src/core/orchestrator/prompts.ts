import { formatLocator } from '../citation';
import type { Locator } from '../types';

export const NOTES_PROMPT_VERSION = 'notes-v1';
export const NOTES_SINGLE_PROMPT_VERSION = 'notes-single-v1';
export const CHARACTERS_PROMPT_VERSION = 'characters-v1';

export interface ChunkSummaryInput {
  chunkIndex: number;
  summary: string;
  keyEvents: string[];
  loc: Locator;
}

export function buildChunkSummaryPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  text: string;
}): string {
  return `你是读书笔记的片段摘要器。书籍《${params.bookTitle}》，章节「${params.chapterTitle}」。

请阅读下面的原文片段，输出 JSON：
{"summary":"200~300字，完整概括本片段的人物、事件、信息","keyEvents":["关键事件/信息，最多5条"],"entities":["人物、地点、概念，最多8个"]}

要求：
1. 只依据原文，不要补充原著之外的情节
2. 保留对后续章节理解有帮助的细节
3. 只输出 JSON，不要解释

原文片段：
${params.text}`;
}

export function buildChapterSummaryPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  chunkSummaries: ChunkSummaryInput[];
}): string {
  const chunks = params.chunkSummaries
    .map(
      (chunk) =>
        `片段 ${chunk.chunkIndex + 1}（${formatLocator(chunk.loc)}）：${chunk.summary}${
          chunk.keyEvents.length ? `\n关键事件：${chunk.keyEvents.join('；')}` : ''
        }`,
    )
    .join('\n\n');

  return `你是读书笔记的章节摘要器。书籍《${params.bookTitle}》，章节「${params.chapterTitle}」。

以下是本章全部片段的摘要，请合并为一条完整的章节摘要，输出 JSON：
{"summary":"400字以内，覆盖本章全部片段和关键情节","keyPoints":["本章要点，最多6条"],"characters":["本章主要人物"]}

要求：
1. 必须覆盖全部片段，不要只写开头
2. 不要编造摘要中没有的信息
3. 只输出 JSON

片段摘要：
${chunks}`;
}

export function buildPartSummaryPrompt(params: {
  bookTitle: string;
  partIndex: number;
  summaries: Array<{ title: string; summary: string; loc: Locator }>;
}): string {
  const body = params.summaries
    .map(
      (item) =>
        `《${item.title}》（${formatLocator(item.loc)}）：${item.summary}`,
    )
    .join('\n\n');

  return `你是读书笔记的分部摘要器。书籍《${params.bookTitle}》，第 ${params.partIndex + 1} 部分。

请把以下章节摘要合并为一份分部摘要，输出 JSON：
{"summary":"500字以内，保留关键情节、人物变化与主题线索"}

要求：覆盖所有章节摘要，不要只写前几章；只输出 JSON。

章节摘要：
${body}`;
}

export function buildNotesOverviewPrompt(params: {
  bookTitle: string;
  chapterTitles: string[];
  summaries: Array<{ title: string; summary: string }>;
}): string {
  const body = params.summaries
    .map((item) => `【${item.title}】${item.summary}`)
    .join('\n\n');

  return `你是资深读书笔记撰写者。书籍《${params.bookTitle}》，共 ${params.chapterTitles.length} 章。

以下是从全书章节抽取的分部/章节摘要：
${body}

请输出 JSON：
{"overview":"书籍主旨与内容概览，200字以内","structure":["按阶段/部分概括全书结构，4~8条"],"themes":["核心主题，3~6条"],"critique":"作品价值、特点与不足，250字以内","conclusion":"总结感悟，150字以内"}

要求：
1. 基于摘要，不要编造情节
2. 不要只写开头章节
3. 只输出 JSON`;
}

/**
 * 长上下文单次路径：全文一次读入，要求覆盖每一章。
 * 若模型漏章或触发上下文超限，任务运行器会降级为 map-reduce。
 */
export function buildSinglePassNotesPrompt(params: {
  bookTitle: string;
  chapterTitles: string[];
  content: string;
}): string {
  const chapterList = params.chapterTitles
    .map((title, index) => `[${index + 1}] ${title}`)
    .join('\n');

  return `你是资深读书笔记撰写者。请一次阅读完整本书《${params.bookTitle}》，输出全书笔记。

章节列表（chapterIndex 从 1 开始，必须为每一章输出摘要）：
${chapterList}

请输出 JSON：
{"overview":"书籍主旨与内容概览，200字以内","structure":["按阶段/部分概括全书结构，4~8条"],"themes":["核心主题，3~6条"],"critique":"作品价值、特点与不足，250字以内","conclusion":"总结感悟，150字以内","chapterSummaries":[{"chapterIndex":1,"summary":"该章摘要，150~250字","keyPoints":["要点"]}]}

要求：
1. chapterSummaries 必须覆盖上面列出的全部章节，顺序一致
2. 摘要基于全书，不要编造情节
3. 只输出 JSON，不要解释

全书正文：
${params.content}`;
}

export function buildChapterBatchSummaryPrompt(params: {
  bookTitle: string;
  chapters: Array<{ chapterIndex: number; title: string; text: string }>;
}): string {
  const body = params.chapters
    .map(
      (chapter) =>
        `【chapterIndex=${chapter.chapterIndex}｜${chapter.title}】\n${chapter.text}`,
    )
    .join('\n\n');

  return `你是读书笔记的片段摘要器。书籍《${params.bookTitle}》。

下面包含 ${params.chapters.length} 个短章节，请为每一章分别输出摘要，合并为 JSON 数组：
[{"chapterIndex":0,"summary":"200~300字","keyEvents":["..."],"entities":["人物、地点、概念"]}]

严格要求：
1. 每个输入章节必须对应且只对应一个输出项，chapterIndex 必须原样返回
2. 禁止把两章合并成一条，禁止遗漏或增加章节
3. 只依据对应章节原文，不要补充原著之外的情节
4. 只输出 JSON 数组，不要解释

章节：
${body}`;
}

export function buildChapterBatchMentionPrompt(params: {
  bookTitle: string;
  chapters: Array<{ chapterIndex: number; title: string; text: string }>;
}): string {
  const body = params.chapters
    .map(
      (chapter) =>
        `【chapterIndex=${chapter.chapterIndex}｜${chapter.title}】\n${chapter.text}`,
    )
    .join('\n\n');

  return `你是人物提及抽取器。书籍《${params.bookTitle}》。

下面包含 ${params.chapters.length} 个章节，请按 chapterIndex 分组输出人物提及，JSON 数组：
[{"chapterIndex":0,"mentions":[{"name":"人物姓名","aliases":["别名"],"quote":"原文逐字句","roleHint":"身份/关系"}]}]

严格要求：
1. 每个输入章节必须对应一个输出项，chapterIndex 必须原样返回，禁止把提及归到其他章节
2. quote 必须逐字摘自对应章节原文，不要改写
3. 只抽取人物专名，不要抽取“他/她/他们/有人/众人”等代词
4. 每章最多 12 条提及；没有人物时 mentions 为 []
5. 只输出 JSON 数组，不要解释

章节：
${body}`;
}

export function buildCharacterMentionPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  text: string;
}): string {
  return `你是人物提及抽取器。书籍《${params.bookTitle}》，章节「${params.chapterTitle}」。

请从原文片段中抽取所有人物的提及，输出 JSON 数组：
[{"name":"人物姓名或称呼","aliases":["别名/称谓"],"quote":"原文中逐字出现的一句话","roleHint":"身份、关系或作用"}]

要求：
1. quote 必须逐字摘自原文，不要改写
2. 只抽取具体人物专名，不要抽取“他/她/他们/有人/众人”等代词
3. 同一人物在同一片段多次出现可合并为一条，最多 12 条
4. 没有人物时输出 []
5. 只输出 JSON

原文片段：
${params.text}`;
}

export function buildCharacterAnalysisPrompt(params: {
  bookTitle: string;
  name: string;
  aliases: string[];
  mentions: Array<{
    id: string;
    chapterTitle: string;
    loc: Locator;
    quote: string;
    roleHint?: string;
  }>;
}): string {
  const mentions = params.mentions
    .map(
      (mention) =>
        `${mention.id}｜${mention.chapterTitle}｜${formatLocator(mention.loc)}${
          mention.roleHint ? `｜${mention.roleHint}` : ''
        }\n“${mention.quote}”`,
    )
    .join('\n\n');

  return `你是人物分析器。书籍《${params.bookTitle}》，人物「${params.name}」${
    params.aliases.length ? `（别名：${params.aliases.join('、')}）` : ''
  }。

以下是从全书不同章节抽取的人物提及（编号｜章节｜位置｜身份提示）：
${mentions}

请基于全部提及输出 JSON：
{"overview":"人物总体分析，250字以内","traits":["性格特点，3~5条"],"arc":"人物弧光与变化，150字以内","relationships":[{"target":"另一人物","description":"关系与冲突"}],"citations":["M1","M3"]}

要求：
1. citations 只能使用上面出现的编号，选择 3~8 条覆盖不同章节
2. 不要只依据第一次出场
3. 只输出 JSON`;
}

export function buildRelationshipReportPrompt(params: {
  bookTitle: string;
  characters: Array<{
    name: string;
    aliases: string[];
    mentionCount: number;
    overview: string;
    relationships: Array<{ target: string; description: string }>;
  }>;
}): string {
  const body = params.characters
    .map(
      (character) =>
        `【${character.name}（${character.aliases.join('、') || '无别名'}），提及${character.mentionCount}次】\n${character.overview}\n关系：${character.relationships
          .map((relation) => `${relation.target}：${relation.description}`)
          .join('；') || '未明确'}`,
    )
    .join('\n\n');

  return `你是人物关系分析器。书籍《${params.bookTitle}》。

以下是全书主要人物的分析：
${body}

请输出 JSON：
{"overview":"全书人物关系总览，200字以内","network":[{"from":"人物A","to":"人物B","relation":"关系/冲突/变化"}],"conclusion":"人物关系与主题的关系，150字以内"}

要求：
1. 只基于以上分析，不要编造人物
2. network 覆盖主要人物之间的关键关系
3. 只输出 JSON`;
}
