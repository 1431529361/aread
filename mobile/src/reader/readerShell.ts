import type { Locator } from '../core/types';
import { escapeHtml, safeJsonForScript } from '../core/text/entities';

export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type ReaderKind = 'txt' | 'epub';

export interface ReaderHighlightMark {
  id: number;
  start: number;
  end: number;
  color: string;
}

export interface ReaderShellOptions {
  /** kind/href 让同一个前端脚本同时服务 TXT 与 EPUB 章节 */
  kind: ReaderKind;
  href: string | null;
  title: string;
  /** 已打好 data-s / data-e 的正文 HTML */
  bodyHtml: string;
  hasText: boolean;
  emptyMessage: string;
  theme?: ReaderTheme;
  fontSize?: number;
  lineHeight?: number;
  initialLocator?: Locator | null;
  initialProgress?: number;
  highlights?: readonly ReaderHighlightMark[];
}

const STYLES = `
  :root {
    --fs: 18px;
    --lh: 1.8;
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
  #content p.blk-h1 { font-size: 1.5em; font-weight: 700; margin: 1em 0 0.6em; text-align: left; }
  #content p.blk-h2 { font-size: 1.3em; font-weight: 700; margin: 1em 0 0.5em; text-align: left; }
  #content p.blk-h3 { font-size: 1.15em; font-weight: 700; margin: 0.9em 0 0.45em; text-align: left; }
  #content p.blk-h4, #content p.blk-h5, #content p.blk-h6 { font-weight: 700; margin: 0.8em 0 0.4em; text-align: left; }
  #content p.blk-blockquote { border-left: 3px solid var(--line); padding-left: 0.8em; color: var(--muted); }
  #content p.blk-pre { white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; }
  #content p.blk-li { padding-left: 1.2em; position: relative; }
  #content p.blk-li::before { content: "•"; position: absolute; left: 0.2em; color: var(--muted); }
  #content p.blk-figcaption { font-size: 0.85em; color: var(--muted); text-align: center; }
  #content p.blk-media { text-align: center; margin: 1em 0; }
  #content p.blk-media img { max-width: 100%; height: auto; border-radius: 4px; }
  #content img { max-width: 100%; height: auto; }
  #content hr { border: 0; border-top: 1px solid var(--line); margin: 1.4em 0; }
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
`;

const SCRIPT = `
(function () {
  var INITIAL = %%INITIAL%%;
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

  function clearMarks(p) {
    var marks = p.querySelectorAll('mark.hl');
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      var parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    }
    if (marks.length) p.normalize();
  }

  function textNodesOf(p) {
    var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    var offset = Number(p.dataset.s) || 0;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue || '';
      nodes.push({ node: node, start: offset, end: offset + value.length });
      offset += value.length;
    }
    return nodes;
  }

  // 按绝对 offset 切分文本节点，只给命中区间套 <mark>；行内样式（b/i 等）得以保留。
  function applyRanges(p, ranges) {
    var nodes = textNodesOf(p);
    for (var n = 0; n < nodes.length; n++) {
      var entry = nodes[n];
      var textNode = entry.node;
      var value = textNode.nodeValue || '';
      if (!value) continue;

      var cuts = [];
      for (var r = 0; r < ranges.length; r++) {
        var range = ranges[r];
        if (range.a > entry.start && range.a < entry.end) cuts.push(range.a);
        if (range.b > entry.start && range.b < entry.end) cuts.push(range.b);
      }
      if (cuts.length === 0) continue;

      cuts.push(entry.start, entry.end);
      cuts.sort(function (x, y) { return x - y; });
      var unique = [];
      for (var c = 0; c < cuts.length; c++) {
        if (c === 0 || cuts[c] !== cuts[c - 1]) unique.push(cuts[c]);
      }

      var fragment = document.createDocumentFragment();
      for (var s = 0; s + 1 < unique.length; s++) {
        var from = unique[s];
        var to = unique[s + 1];
        var piece = value.slice(from - entry.start, to - entry.start);
        if (!piece) continue;
        var owner = null;
        for (var k = 0; k < ranges.length; k++) {
          if (ranges[k].a <= from && ranges[k].b >= to) { owner = ranges[k]; break; }
        }
        if (!owner) {
          fragment.appendChild(document.createTextNode(piece));
        } else {
          var mark = document.createElement('mark');
          mark.className = 'hl hl-' + owner.color;
          mark.setAttribute('data-hl', String(owner.id));
          mark.appendChild(document.createTextNode(piece));
          fragment.appendChild(mark);
        }
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  function rebuildHighlights(highlights) {
    var list = paragraphs();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var start = Number(p.dataset.s);
      var end = Number(p.dataset.e);
      clearMarks(p);
      if (start === end) continue;

      var ranges = [];
      for (var j = 0; j < highlights.length; j++) {
        var h = highlights[j];
        if (h.end <= start || h.start >= end) continue;
        ranges.push({
          a: Math.max(start, h.start),
          b: Math.min(end, h.end),
          color: h.color || 'yellow',
          id: h.id
        });
      }
      if (ranges.length === 0) continue;
      ranges.sort(function (x, y) { return x.a - y.a || x.b - y.b; });
      applyRanges(p, ranges);
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
      locator: { kind: INITIAL.kind, href: INITIAL.href, start: start, end: end }
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
`;

/**
 * 生成可离线运行的阅读器 HTML（TXT 全文或 EPUB 单章共用同一套前端脚本）。
 * 正文块的 data-s / data-e 由调用方保证，脚本只负责选区、划线、进度与跳转。
 */
export function buildReaderShell(options: ReaderShellOptions): string {
  const theme = options.theme ?? 'light';
  const fontSize = Math.max(12, Math.min(32, options.fontSize ?? 18));
  const lineHeight = Math.max(1.3, Math.min(2.4, options.lineHeight ?? 1.8));

  const initial = {
    kind: options.kind,
    href: options.href,
    locator: options.initialLocator ?? null,
    progress: Math.max(0, Math.min(1, options.initialProgress ?? 0)),
    highlights: options.highlights ?? [],
    hasText: options.hasText,
  };

  const script = SCRIPT.replace('%%INITIAL%%', safeJsonForScript(initial));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${escapeHtml(options.title)}</title>
<style>
  :root { --fs: ${fontSize}px; --lh: ${lineHeight}; }${STYLES}
</style>
</head>
<body class="theme-${theme}">
<div id="content">${options.bodyHtml}</div>
${options.hasText ? '' : `<div id="empty">${escapeHtml(options.emptyMessage)}</div>`}
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
<script>${script}</script>
</body>
</html>`;
}