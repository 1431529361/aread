import type { DbExecutor } from '../adapter';
import { LOCAL_USER_ID } from '../schema';

export async function getSetting(
  db: DbExecutor,
  key: string,
  userId = LOCAL_USER_ID,
): Promise<string | null> {
  const row = await db.queryOne<{ value: string | null }>(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
    [userId, key],
  );
  return row?.value ?? null;
}

export async function setSetting(
  db: DbExecutor,
  params: { key: string; value: string; userId?: string },
): Promise<void> {
  const userId = params.userId ?? LOCAL_USER_ID;
  await db.execute(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [userId, params.key, params.value],
  );
}

export async function deleteSetting(db: DbExecutor, key: string): Promise<void> {
  await db.execute('DELETE FROM user_settings WHERE user_id = ? AND key = ?', [
    LOCAL_USER_ID,
    key,
  ]);
}

export async function getJsonSetting<T>(
  db: DbExecutor,
  key: string,
  fallback: T,
): Promise<T> {
  const raw = await getSetting(db, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function setJsonSetting(
  db: DbExecutor,
  key: string,
  value: unknown,
): Promise<void> {
  await setSetting(db, { key, value: JSON.stringify(value) });
}
