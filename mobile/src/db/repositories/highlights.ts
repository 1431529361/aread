import type { DbAdapter } from '../adapter';
import type { Locator } from '../../core/types';
import { locatorFromRow, locatorToRow } from '../../reader/locator';

export interface HighlightRecord {
  id: number;
  bookId: string;
  loc: Locator;
  selectedText: string;
  note: string | null;
  color: string;
  createdAt: string;
}

interface HighlightRow {
  id: number;
  book_id: string;
  loc_kind: string;
  loc_href: string | null;
  loc_start: number;
  loc_end: number;
  selected_text: string;
  note: string | null;
  color: string;
  created_at: string;
}

function mapHighlight(row: HighlightRow): HighlightRecord {
  return {
    id: Number(row.id),
    bookId: row.book_id,
    loc: locatorFromRow({
      loc_kind: row.loc_kind as 'txt' | 'epub',
      loc_href: row.loc_href,
      loc_start: Number(row.loc_start),
      loc_end: Number(row.loc_end),
    }),
    selectedText: row.selected_text,
    note: row.note,
    color: row.color,
    createdAt: row.created_at,
  };
}

export async function addHighlight(
  db: DbAdapter,
  params: {
    bookId: string;
    loc: Locator;
    selectedText: string;
    note?: string | null;
    color?: string;
    now?: string;
  },
): Promise<HighlightRecord> {
  const loc = locatorToRow(params.loc);
  const now = params.now ?? new Date().toISOString();
  const result = await db.execute(
    `INSERT INTO highlights
      (book_id, loc_kind, loc_href, loc_start, loc_end, selected_text, note, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.bookId,
      loc.loc_kind,
      loc.loc_href,
      loc.loc_start,
      loc.loc_end,
      params.selectedText,
      params.note ?? null,
      params.color ?? 'yellow',
      now,
      now,
    ],
  );
  const row = await db.queryOne<HighlightRow>(
    'SELECT * FROM highlights WHERE id = ?',
    [Number(result.lastInsertRowId)],
  );
  if (!row) throw new Error('写入划线失败');
  return mapHighlight(row);
}

export async function listHighlights(
  db: DbAdapter,
  bookId: string,
): Promise<HighlightRecord[]> {
  const rows = await db.queryAll<HighlightRow>(
    'SELECT * FROM highlights WHERE book_id = ? ORDER BY loc_start ASC, id ASC',
    [bookId],
  );
  return rows.map(mapHighlight);
}

export async function deleteHighlight(
  db: DbAdapter,
  params: { bookId: string; highlightId: number },
): Promise<void> {
  await db.execute('DELETE FROM highlights WHERE book_id = ? AND id = ?', [
    params.bookId,
    params.highlightId,
  ]);
}
