import type { IndexStatus } from '../core/types';
import type { BadgeTone } from './ui';

export function indexStatusMeta(status: IndexStatus): {
  label: string;
  tone: BadgeTone;
  searchable: boolean;
} {
  switch (status) {
    case 'pending':
      return { label: '待索引', tone: 'neutral', searchable: false };
    case 'chunking':
      return { label: '分块中', tone: 'info', searchable: false };
    case 'embedding':
      return { label: '向量化中', tone: 'info', searchable: true };
    case 'lexical_ready':
      return { label: '可检索', tone: 'success', searchable: true };
    case 'ready':
      return { label: '已就绪', tone: 'success', searchable: true };
    case 'partial':
      return { label: '部分完成', tone: 'warn', searchable: true };
    default:
      return { label: '待索引', tone: 'neutral', searchable: false };
  }
}

export function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '尚未阅读';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

export function formatCount(value: number): string {
  const count = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count} 字`;
}
