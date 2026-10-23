import { splitParagraphs } from '../core/rag/chunk';
import type { Locator } from '../core/types';

export type ReaderTheme = 'light' | 'sepia' | 'dark';

export interface ReaderHighlightMark {
  id: number;
  start: number;
  end: number;
  color: string;
}

export interface ReaderHtmlOptions {
  title: string;
  text: string;
  theme?: ReaderTheme;
  fontSize?: number;
  lineHeight?: number;
  initialLocator?: Locator | null;
  initialProgress?: number;
  highlights?: readonly ReaderHighlightMark[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 生成可离线运行的阅读器 HTML；正文按段落打上 locator offset。 */
export function buildReaderHtml(options: ReaderHtmlOptions): string {
  const theme = options.theme ?? 'light';
  const fontSize = Math.max(12, Math.min(32, options.fontSize ?? 18));
  const lineHeight = Math.max(1.3, Math.min(2.4, options.lineHeight ?? 1.8));
  const paragraphs = splitParagraphs(options.text);

  const body = paragraphs
    .map(
      (paragraph) =>
        `<p data-s="${paragraph.start}" data-e="${paragraph.end}">${escapeHtml(paragraph.text)}</p>`,
    )
    .join('\n');

  const initial = {
    locator: options.initialLocator ?? null,
    progress: Math.max(0, Math.min(1, options.initialProgress ?? 0)),
    highlights: options.highlights ?? [],
    hasText: paragraphs.length > 0,
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${escapeHtml(options.title)}</title>
<style>
  :root {
    --fs: ${fontSize}px;
    --lh: ${lineHeight};
    --bg: #faf7f2;
    --fg: #2b2926;
    --muted: #8a837a;
    --accent: #b4552d;
    --line: rgba(0,0,0,0.08);
    --hl-yellow: rgba(246, 211, 101, 0.55);
    --hl-green: rgba(134, 208, 154, 0.5);
    --hl-blue: rgba(126, 181, 235, 0.45);
    --hl-pink: rgba(238, 154, 178, 0.45);
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: -apple-system, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif;
    font-size: var(--fs);
    line-height: var(--lh);
    -webkit-text-size-adjust: 100%;
    overflow-wrap: break-word;
  }
  body.theme-sepia { --bg: #f3ead8; --fg: #3a3127; --muted: #8d7d66; }
  body.theme-dark { --bg: #191817; --fg: #ddd8d0; --muted: #8f8880; --line: rgba(255,255,255,0.1); }
  #content { padding: 20px 20px 96px; max-width: 760px; margin: 0 auto; }
  #content p { margin: 0 0 0.85em; text-align: justify; }
  #content p:first-child { margin-top: 8px; }
  .hl { border-radius: 2px; color: inherit; padding: 0; background: transparent; }
  .hl-yellow { background: var(--hl-yellow); }
  .hl-green { background: var(--hl-green); }
  .hl-blue { background: var(--hl-blue); }
  .hl-pink { background: var(--hl-pink); }
  .jump-flash { animation: flash 1.4s ease-out; border-radius: 4px; }
  @keyframes flash { 0% { background: rgba(180,85,45,0.28); } 100% { background: transparent; } }
  #empty { color: var(--muted); text-align: center; padding: 48px 24px; }
  #selbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    background: rgba(30, 28, 26, 0.96); color: #fff;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    transform: translateY(110%); transition: transform 0.16s ease-out;
    box-shadow: 0 -6px 24px rgba(0,0,0,0.2);
  }
  #selbar.visible { transform: translateY(0); }
  #seltext {
    font-family: system-ui, sans-serif; font-size: 12px; line-height: 1.5;
    color: rgba(255,255,255,0.72); max-height: 3.2em; overflow: hidden;
    margin-bottom: 8px;
  }
  #selbar .actions { display: flex; gap: 6px; }
  #selbar button {
    flex: 1; border: 0; border-radius: 8px; padding: 10px 4px;
    background: rgba(255,255,255,0.12); color: #fff;
    font-size: 13px; font-family: system-ui, sans-serif;
  }
  #selbar button.primary { background: var(--accent); }
  #toast {
    position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%) translateY(8px);
    background: rgba(0,0,0,0.78); color: #fff; font: 12px/1.4 system-ui, sans-serif;
    padding: 8px 14px; border-radius: 20px; opacity: 0; pointer-events: none;
    transition: opacity 0.2s, transform 0.2s; z-index: 30; white-space: nowrap;
  }
  #toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body class="theme-${theme}">
<div id="content">${body}</div>
${paragraphs.length === 0 ? '<div id="empty">这本书还没有可显示的正文。</div>' : ''}
<div id="selbar">
  <div id="seltext"></div>
  <div class="actions">
    <button class="primary" data-action="ask">提问</button>
    <button data-action="highlight">划线</button>
    <button data-action="search">全书搜索</button>
    <button data-action="copy">复制</button>
    <button data-action="cancel">取消</button>
  </div>
</div>
<div id="toast"></div>
<script>
(function () {
  var INITIAL = ${safeJson(initial)};
  var content = document.getElementById('content');
  var selbar = document.getElementById('selbar');
  var seltext = document.getElementById('seltext');
  var toastEl = document.getElementById('toast');
  var current = null;
  var lastProgressSent = 0;
  var toastTimer = null;

  function post(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, 1600);
  }

  function paragraphs() {
    return content.querySelectorAll('p');
  }

  function findParagraph(offset) {
    var list = paragraphs();
    var low = 0, high = list.length - 1, found = null;
    while (low <= high) {
      var mid = (low + high) >> 1;
      var p = list[mid];
      var start = Number(p.dataset.s);
      var end = Number(p.dataset.e);
      if (offset < start) high = mid - 1;
      else if (offset >= end) { found = p; low = mid + 1; }
      else return p;
    }
    return found || list[0] || null;
  }

  function rebuildHighlights(highlights) {
    var list = paragraphs();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var text = p.textContent || '';
      var start = Number(p.dataset.s);
      var end = Number(p.dataset.e);
      var ranges = [];
      for (var j = 0; j < highlights.length; j++) {
        var h = highlights[j];
        if (h.end <= start || h.start >= end) continue;
        ranges.push({
          a: Math.max(0, h.start - start),
          b: Math.min(text.length, h.end - start),
          color: h.color || 'yellow',
          id: h.id
        });
      }
      ranges.sort(function (x, y) { return x.a - y.a || x.b - y.b; });
      var html = '';
      var cursor = 0;
      for (var k = 0; k < ranges.length; k++) {
        var range = ranges[k];
        if (range.b <= cursor) continue;
        var from = Math.max(cursor, range.a);
        html += esc(text.slice(cursor, from));
        html += '<mark class="hl hl-' + esc(range.color) + '" data-hl="' + esc(range.id) + '">' +
          esc(text.slice(from, range.b)) + '</mark>';
        cursor = range.b;
      }
      html += esc(text.slice(cursor));
      p.innerHTML = html;
    }
  }

  function absoluteOffset(node, offset) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return null;
    var p = element.closest ? element.closest('p') : null;
    if (!p || !content.contains(p)) return null;
    var range = document.createRange();
    range.setStart(p, 0);
    range.setEnd(node, offset);
    return Number(p.dataset.s) + range.toString().length;
  }

  function trimmedSelection() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var raw = selection.toString();
    if (!raw || !raw.trim()) return null;
    var range = selection.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return null;

    var start = absoluteOffset(range.startContainer, range.startOffset);
    var end = absoluteOffset(range.endContainer, range.endOffset);
    if (start == null || end == null) return null;
    if (end < start) { var temp = start; start = end; end = temp; }

    var leading = raw.length - raw.replace(/^\\s+/, '').length;
    var trailing = raw.length - raw.replace(/\\s+$/, '').length;
    start += leading;
    end -= trailing;
    if (end <= start) return null;

    var text = raw.trim();
    return { text: text, start: start, end: end };
  }

  function hideToolbar() {
    current = null;
    selbar.classList.remove('visible');
  }

  function refreshSelection() {
    var trimmed = trimmedSelection();
    if (!trimmed) { hideToolbar(); return; }
    current = trimmed;
    seltext.textContent = trimmed.text.length > 120
      ? trimmed.text.slice(0, 120) + '…'
      : trimmed.text;
    selbar.classList.add('visible');
    post({ type: 'selection', text: trimmed.text, start: trimmed.start, end: trimmed.end });
  }

  function locatorNow() {
    var list = paragraphs();
    var probe = window.scrollY + 24;
    var chosen = null;
    for (var i = 0; i < list.length; i++) {
      var top = list[i].offsetTop;
      if (top <= probe) chosen = list[i];
      else break;
    }
    if (!chosen) chosen = list[0] || null;
    var start = chosen ? Number(chosen.dataset.s) : 0;
    var end = chosen ? Number(chosen.dataset.e) : 0;
    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    var progress = Math.min(1, Math.max(0, window.scrollY / max));
    return {
      progress: progress,
      locator: { kind: 'txt', href: null, start: start, end: end }
    };
  }

  function reportProgress(force) {
    var now = Date.now();
    if (!force && now - lastProgressSent < 700) return;
    lastProgressSent = now;
    var value = locatorNow();
    post({ type: 'progress', progress: value.progress, locator: value.locator });
  }

  function scrollToLocator(locator) {
    if (!locator) return;
    var p = findParagraph(Number(locator.start) || 0);
    if (!p) return;
    var top = Math.max(0, p.offsetTop - 12);
    window.scrollTo(0, top);
    p.classList.remove('jump-flash');
    void p.offsetWidth;
    p.classList.add('jump-flash');
    setTimeout(function () { p.classList.remove('jump-flash'); }, 1500);
  }

  function clearSelection() {
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    hideToolbar();
  }

  function copyText(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) { toast('已复制'); return; }
    } catch (error) {
      // 继续走 Clipboard API
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('已复制'); },
        function () { toast('复制失败，请长按选择'); }
      );
    } else {
      toast('复制失败，请长按选择');
    }
  }

  selbar.addEventListener('mousedown', function (event) { event.preventDefault(); });
  selbar.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button') : null;
    if (!button) return;
    var action = button.dataset.action;
    var selected = current;
    if (!selected) return;

    if (action === 'copy') {
      copyText(selected.text);
      clearSelection();
      return;
    }
    if (action === 'cancel') {
      clearSelection();
      return;
    }
    post({
      type: 'action',
      action: action,
      text: selected.text,
      start: selected.start,
      end: selected.end
    });
    clearSelection();
  });

  var selectionTimer = null;
  document.addEventListener('selectionchange', function () {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      refreshSelection();
    }, 120);
  });

  document.addEventListener('touchend', function (event) {
    if (event.target.closest && event.target.closest('#selbar')) return;
    setTimeout(refreshSelection, 80);
  }, { passive: true });

  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      reportProgress(false);
    }, 220);
  }, { passive: true });

  window.addEventListener('resize', function () { reportProgress(true); });

  window.__reader = {
    goTo: function (locator) {
      if (locator) scrollToLocator(locator);
    },
    setHighlights: function (highlights) {
      var y = window.scrollY;
      rebuildHighlights(highlights || []);
      window.scrollTo(0, y);
    },
    setStyle: function (style) {
      if (!style) return;
      if (style.fontSize) document.documentElement.style.setProperty('--fs', style.fontSize + 'px');
      if (style.lineHeight) document.documentElement.style.setProperty('--lh', String(style.lineHeight));
      if (style.theme) {
        document.body.className = 'theme-' + style.theme;
      }
    },
    getLocator: locatorNow,
    clearSelection: clearSelection
  };

  function boot() {
    rebuildHighlights(INITIAL.highlights);
    if (!INITIAL.hasText) {
      post({ type: 'ready' });
      return;
    }

    setTimeout(function () {
      if (INITIAL.locator && INITIAL.locator.start > 0) {
        scrollToLocator(INITIAL.locator);
      } else if (INITIAL.progress > 0) {
        var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.round(max * INITIAL.progress));
      }
      post({ type: 'ready' });
      reportProgress(true);
    }, 60);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>
</body>
</html>`;
}
