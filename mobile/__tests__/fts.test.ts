import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildFtsQuery, escapeFtsToken } from '../src/core/rag/fts';
import { toFtsDocument } from '../src/core/rag/tokenize';

describe('buildFtsQuery', () => {
  it('分词去重后用 OR 连接', () => {
    expect(buildFtsQuery('你好 世界')).toBe(
      '"你" OR "好" OR "你好" OR "世" OR "界" OR "世界"',
    );
  });

  it('纯标点查询返回空串', () => {
    expect(buildFtsQuery('“”，。！？ - *')).toBe('');
  });

  it('特殊字符不会进入查询串', () => {
    const query = buildFtsQuery('C++ "quoted" -foo*');
    expect(query).toBe('"quoted" OR "foo"');
    expect(query).not.toContain('*');
    expect(query).not.toContain('-');
  });

  it('token 内双引号按 FTS5 规则转义', () => {
    expect(escapeFtsToken('a"b')).toBe('"a""b"');
  });
});

describe('FTS5 集成（Node 内置 SQLite）', () => {
  it('预分词文档可被中文查询命中，特殊字符查询不抛错', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE rag_fts USING fts5(
      chunk_id UNINDEXED,
      book_id UNINDEXED,
      tokens,
      tokenize = 'unicode61'
    )`);

    const insert = db.prepare(
      'INSERT INTO rag_fts (chunk_id, book_id, tokens) VALUES (?, ?, ?)',
    );
    insert.run(1, 'book-1', toFtsDocument('他说：“你好，世界！”'));
    insert.run(2, 'book-1', toFtsDocument('Another chapter about reading'));

    const search = db.prepare(
      'SELECT chunk_id FROM rag_fts WHERE rag_fts MATCH ? ORDER BY rank',
    );
    const chineseHits = search.all(buildFtsQuery('你好')) as Array<{ chunk_id: number }>;
    expect(chineseHits.map((row) => Number(row.chunk_id))).toContain(1);

    const englishHits = search.all(buildFtsQuery('reading')) as Array<{ chunk_id: number }>;
    expect(englishHits.map((row) => Number(row.chunk_id))).toContain(2);

    expect(() => search.all(buildFtsQuery('hello -world* "unterminated'))).not.toThrow();

    db.close();
  });
});
