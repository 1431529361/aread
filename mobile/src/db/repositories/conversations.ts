import type { DbAdapter } from '../adapter';
import type { Evidence } from '../../core/types';

export type ConversationScope = 'book' | 'library';

export interface ConversationRecord {
  id: string;
  bookId: string | null;
  scope: ConversationScope;
  title: string;
  status: string;
  summary: string;
  summaryUpto: number;
  tokenEstimate: number;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageRecord {
  id: number;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: string;
  citations: Evidence[] | null;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  book_id: string | null;
  scope: string;
  title: string | null;
  status: string | null;
  summary: string | null;
  summary_upto: number | null;
  token_estimate: number | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  seq: number;
  role: string;
  content: string | null;
  citations: string | null;
  created_at: string;
}

const DEFAULT_TITLE = '新对话';

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    scope: row.scope === 'library' ? 'library' : 'book',
    title: row.title || DEFAULT_TITLE,
    status: row.status ?? 'active',
    summary: row.summary ?? '',
    summaryUpto: Number(row.summary_upto ?? 0),
    tokenEstimate: Number(row.token_estimate ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCitations(raw: string | null): Evidence[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as Evidence[]) : null;
  } catch {
    return null;
  }
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    role: row.role as MessageRole,
    content: row.content ?? '',
    citations: parseCitations(row.citations),
    createdAt: row.created_at,
  };
}

function newConversationId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function getConversation(
  db: DbAdapter,
  params: { userId: string; conversationId: string },
): Promise<ConversationRecord | null> {
  const row = await db.queryOne<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    [params.conversationId, params.userId],
  );
  return row ? mapConversation(row) : null;
}

export async function listConversationsForBook(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<ConversationRecord[]> {
  const rows = await db.queryAll<ConversationRow>(
    `SELECT * FROM conversations
     WHERE user_id = ? AND book_id = ? AND scope = 'book'
     ORDER BY updated_at DESC`,
    [params.userId, params.bookId],
  );
  return rows.map(mapConversation);
}

/** 新建会话时把同书同 scope 的旧 active 会话归档。 */
export async function createConversation(
  db: DbAdapter,
  params: {
    userId: string;
    bookId?: string | null;
    scope?: ConversationScope;
    title?: string;
    provider?: string | null;
    model?: string | null;
    now?: string;
  },
): Promise<ConversationRecord> {
  const id = newConversationId();
  const now = params.now ?? new Date().toISOString();
  const scope = params.scope ?? 'book';
  const bookId = params.bookId ?? null;

  await db.transaction(async (tx) => {
    if (scope === 'library') {
      await tx.execute(
        `UPDATE conversations SET status = 'archived', updated_at = ?
         WHERE user_id = ? AND scope = 'library' AND status = 'active'`,
        [now, params.userId],
      );
    } else if (bookId) {
      await tx.execute(
        `UPDATE conversations SET status = 'archived', updated_at = ?
         WHERE user_id = ? AND book_id = ? AND scope = ? AND status = 'active'`,
        [now, params.userId, bookId, scope],
      );
    }
    await tx.execute(
      `INSERT INTO conversations
        (id, user_id, book_id, scope, title, status, summary, summary_upto,
         token_estimate, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', '', 0, 0, ?, ?, ?, ?)`,
      [
        id,
        params.userId,
        bookId,
        scope,
        params.title ?? DEFAULT_TITLE,
        params.provider ?? null,
        params.model ?? null,
        now,
        now,
      ],
    );
  });

  const created = await getConversation(db, {
    userId: params.userId,
    conversationId: id,
  });
  if (!created) throw new Error('创建会话失败');
  return created;
}

export async function getOrCreateBookConversation(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<ConversationRecord> {
  const row = await db.queryOne<ConversationRow>(
    `SELECT * FROM conversations
     WHERE user_id = ? AND book_id = ? AND scope = 'book' AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [params.userId, params.bookId],
  );
  if (row) return mapConversation(row);
  return createConversation(db, {
    userId: params.userId,
    bookId: params.bookId,
    scope: 'book',
  });
}

export async function getOrCreateLibraryConversation(
  db: DbAdapter,
  userId: string,
): Promise<ConversationRecord> {
  const row = await db.queryOne<ConversationRow>(
    `SELECT * FROM conversations
     WHERE user_id = ? AND scope = 'library' AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  if (row) return mapConversation(row);
  return createConversation(db, {
    userId,
    bookId: null,
    scope: 'library',
    title: '书库问答',
  });
}

export async function listLibraryConversations(
  db: DbAdapter,
  userId: string,
): Promise<ConversationRecord[]> {
  const rows = await db.queryAll<ConversationRow>(
    `SELECT * FROM conversations
     WHERE user_id = ? AND scope = 'library'
     ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(mapConversation);
}

export async function listMessages(
  db: DbAdapter,
  conversationId: string,
): Promise<MessageRecord[]> {
  const rows = await db.queryAll<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
    [conversationId],
  );
  return rows.map(mapMessage);
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  citations?: Evidence[] | null;
  now?: string;
}

export async function appendMessage(
  db: DbAdapter,
  input: AppendMessageInput,
): Promise<MessageRecord> {
  const now = input.now ?? new Date().toISOString();
  const content = input.content ?? '';
  const citations = input.citations && input.citations.length > 0
    ? JSON.stringify(input.citations)
    : null;
  const tokens = content.length;

  const messageId = await db.transaction(async (tx) => {
    const seqRow = await tx.queryOne<{ next: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?`,
      [input.conversationId],
    );
    const seq = Number(seqRow?.next ?? 1);
    const result = await tx.execute(
      `INSERT INTO messages
        (conversation_id, seq, role, content, citations, token_estimate, in_window, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [input.conversationId, seq, input.role, content, citations, tokens, now],
    );

    await tx.execute(
      `UPDATE conversations
       SET token_estimate = token_estimate + ?, updated_at = ?
       WHERE id = ?`,
      [tokens, now, input.conversationId],
    );

    if (input.role === 'user') {
      const title = content.replace(/\s+/g, ' ').trim().substring(0, 30);
      if (title) {
        await tx.execute(
          `UPDATE conversations SET title = ?
           WHERE id = ? AND (title IS NULL OR title = ?)`,
          [title, input.conversationId, DEFAULT_TITLE],
        );
      }
    }

    return Number(result.lastInsertRowId);
  });

  const row = await db.queryOne<MessageRow>('SELECT * FROM messages WHERE id = ?', [
    messageId,
  ]);
  if (!row) throw new Error('写入消息失败');
  return mapMessage(row);
}

export async function updateMessageCitations(
  db: DbAdapter,
  params: { messageId: number; citations: Evidence[] },
): Promise<void> {
  await db.execute('UPDATE messages SET citations = ? WHERE id = ?', [
    JSON.stringify(params.citations),
    params.messageId,
  ]);
}

export async function deleteConversation(
  db: DbAdapter,
  params: { userId: string; conversationId: string },
): Promise<void> {
  await db.execute('DELETE FROM conversations WHERE id = ? AND user_id = ?', [
    params.conversationId,
    params.userId,
  ]);
}
