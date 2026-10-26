import { create } from 'zustand';
import type { DbAdapter } from '../db/adapter';
import { getDatabase, initDatabase } from '../db/client';
import { getFts5Status, type Fts5Status } from '../db/fts5';
import { getJsonSetting, setJsonSetting } from '../db/repositories/settings';
import {
  getStreamingMode,
  type StreamingMode,
} from '../services/llmRuntime';
import type { ReaderTheme } from '../reader/readerHtml';
import { resumeInterruptedVectorIndexes } from '../services/indexRuntime';

export interface ReaderPrefs {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'light',
  fontSize: 18,
  lineHeight: 1.8,
};

const READER_PREFS_KEY = 'reader_prefs';

interface AppState {
  ready: boolean;
  initError: string | null;
  fts5: Fts5Status;
  streaming: StreamingMode;
  libraryVersion: number;
  readerPrefs: ReaderPrefs;
  initialize: () => Promise<void>;
  bumpLibrary: () => void;
  updateReaderPrefs: (patch: Partial<ReaderPrefs>) => void;
}

let initPromise: Promise<void> | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  initError: null,
  fts5: getFts5Status(),
  streaming: getStreamingMode(),
  libraryVersion: 0,
  readerPrefs: DEFAULT_READER_PREFS,

  initialize: async () => {
    if (get().ready) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const { db, fts5 } = await initDatabase();
        const prefs = await getJsonSetting<ReaderPrefs>(
          db,
          READER_PREFS_KEY,
          DEFAULT_READER_PREFS,
        );
        set({
          ready: true,
          initError: null,
          fts5,
          streaming: getStreamingMode(),
          readerPrefs: { ...DEFAULT_READER_PREFS, ...prefs },
        });
        void resumeInterruptedVectorIndexes(db).catch(() => {
          // 续跑失败会由索引状态记录，不能阻塞 App 启动
        });
      } catch (error) {
        initPromise = null;
        set({
          ready: false,
          initError: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return initPromise;
  },

  bumpLibrary: () => set((state) => ({ libraryVersion: state.libraryVersion + 1 })),

  updateReaderPrefs: (patch) => {
    const next = { ...get().readerPrefs, ...patch };
    set({ readerPrefs: next });
    void persistReaderPrefs(next);
  },
}));

export function getDbOrNull(): DbAdapter | null {
  try {
    return getDatabase();
  } catch {
    return null;
  }
}

export async function persistReaderPrefs(prefs: ReaderPrefs): Promise<void> {
  const db = getDbOrNull();
  if (!db) return;
  try {
    await setJsonSetting(db, READER_PREFS_KEY, prefs);
  } catch {
    // 偏好写入失败不影响阅读
  }
}
