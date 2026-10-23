import * as SecureStore from 'expo-secure-store';
import type { ProviderKind } from '../db/repositories/providers';

export const CHAT_API_KEY = 'chat_api_key';
export const EMBEDDING_API_KEY = 'embedding_api_key';

export function secureKeyName(kind: ProviderKind): string {
  return kind === 'chat' ? CHAT_API_KEY : EMBEDDING_API_KEY;
}

export async function getApiKey(kind: ProviderKind): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(secureKeyName(kind));
  } catch {
    return null;
  }
}

export async function setApiKey(kind: ProviderKind, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(secureKeyName(kind), apiKey);
}

export async function deleteApiKey(kind: ProviderKind): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(secureKeyName(kind));
  } catch {
    // 已不存在时忽略
  }
}

export function maskApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
