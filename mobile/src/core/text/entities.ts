const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  dagger: '†',
  permil: '‰',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  deg: '°',
  micro: 'µ',
  para: '¶',
  sect: '§',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  oelig: 'œ',
  OElig: 'Œ',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
};

const NUMERIC_ENTITY = /^#(\d{1,7}|x[0-9a-fA-F]{1,6})$/;

/** 解码常见命名实体与数字实体；未知实体保持原样，避免吞掉正文。 */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});?/g, (match, body: string) => {
    if (!match.endsWith(';')) return match;
    const named = NAMED_ENTITIES[body];
    if (named != null) return named;
    const numeric = NUMERIC_ENTITY.exec(body);
    if (!numeric) return match;
    const raw = numeric[1];
    const code = raw[0] === 'x' || raw[0] === 'X'
      ? Number.parseInt(raw.slice(1), 16)
      : Number.parseInt(raw, 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    // 代理区码位非法，直接丢弃以免生成坏字符串
    if (code >= 0xd800 && code <= 0xdfff) return '';
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON 内嵌到 <script> 时的安全序列化。 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}