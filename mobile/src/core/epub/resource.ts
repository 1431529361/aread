import { bytesToBase64 } from '../text/bytes';

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
};

/** 去掉 URL 片段与查询串。 */
export function stripFragment(href: string): string {
  const hash = href.indexOf('#');
  const withoutHash = hash >= 0 ? href.slice(0, hash) : href;
  const query = withoutHash.indexOf('?');
  return query >= 0 ? withoutHash.slice(0, query) : withoutHash;
}

export function fragmentOf(href: string): string {
  const hash = href.indexOf('#');
  return hash >= 0 ? href.slice(hash + 1) : '';
}

/** 逐段解码 percent-encoding；解不开时保留原文。 */
export function decodeUriPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment.includes('%')) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 把 baseDir 与相对/绝对 href 归一化成 ZIP 内的 posix 路径。 */
export function resolvePath(baseDir: string, href: string): string {
  const cleaned = decodeUriPath(stripFragment(href).replace(/\\/g, '/')).trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('/')) return normalizeSegments(cleaned.slice(1));
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizeSegments(`${base}/${cleaned}`);
}

function normalizeSegments(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function mimeForPath(path: string): string {
  const ext = extname(path);
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  switch (ext) {
    case 'xhtml':
    case 'html':
    case 'htm':
      return 'application/xhtml+xml';
    case 'css':
      return 'text/css';
    case 'ncx':
      return 'application/x-dtbncx+xml';
    case 'opf':
      return 'application/oebps-package+xml';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export function isImagePath(path: string): boolean {
  return Boolean(IMAGE_MIME[extname(path)]);
}

/** 生成可直接嵌入 WebView 的 data URI，离线阅读时图片不依赖网络。 */
export function toDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** ZIP 条目查找用的宽松 key：解码 percent-encoding、统一小写。 */
export function entryKey(path: string): string {
  return decodeUriPath(path.replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase();
}