// 阅读器：上传 TXT、解析章节、目录、字号/主题

import { store } from './store.js';
import { $, $id, $$, escapeHtml, showToast } from './utils.js';

let originalContent = null;
let currentFontSize = 18;
let currentTheme = localStorage.getItem('theme') || 'light';

export function initReader() {
    originalContent = {
        title: $id('articleTitle').textContent,
        meta: $id('articleMeta').innerHTML,
        content: $id('articleContent').innerHTML
    };
    applyTheme(currentTheme);

    // 字号
    $id('decreaseFont').addEventListener('click', () => changeFontSize(-2));
    $id('increaseFont').addEventListener('click', () => changeFontSize(2));
    applyFontSize(currentFontSize);

    // 主题
    document.querySelectorAll('.theme-btn').forEach(btn => {
        if (btn.dataset.theme === currentTheme) btn.classList.add('active');
        else btn.classList.remove('active');
        btn.addEventListener('click', () => {
            currentTheme = btn.dataset.theme;
            localStorage.setItem('theme', currentTheme);
            document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b === btn));
            applyTheme(currentTheme);
        });
    });

    // 初始目录
    bindTocClicks();

    // 拖拽 / 上传
    initFileUpload();
    $id('removeFileBtn').addEventListener('click', removeUploadedFile);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

function applyFontSize(size) {
    $id('articleContent').style.fontSize = `${size}px`;
    $id('fontSizeDisplay').textContent = `${size}px`;
}

export function changeFontSize(delta) {
    currentFontSize = Math.max(12, Math.min(28, currentFontSize + delta));
    applyFontSize(currentFontSize);
}

function initFileUpload() {
    const uploadArea = $id('uploadArea');
    const fileInput = $id('fileInput');
    const uploadBtn = $id('uploadBtn');

    uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    uploadArea.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileUpload(e.target.files[0]);
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });
    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
    });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0]);
    });
}

function handleFileUpload(file) {
    if (!file.name.toLowerCase().endsWith('.txt')) {
        showToast('请上传 .txt 格式的文件');
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => displayContent(file.name, e.target.result);
    reader.onerror = () => showToast('文件读取失败，请重试');
    reader.readAsText(file, 'UTF-8');
}

function displayContent(fileName, content) {
    store.set({ uploadedFileName: fileName });
    const titleWithoutExt = fileName.replace(/\.txt$/i, '');
    $id('articleTitle').textContent = titleWithoutExt;

    const wordCount = content.length;
    const readingTime = Math.max(1, Math.ceil(wordCount / 500));
    $id('articleMeta').innerHTML = `
        <span class="meta-item">文件名：${escapeHtml(fileName)}</span>
        <span class="meta-item">字数：约${wordCount}字</span>
        <span class="meta-item">阅读时间：约${readingTime}分钟</span>
    `;
    $id('articleContent').innerHTML = formatTextContent(content);
    $id('fileName').textContent = fileName;
    $id('fileInfo').style.display = 'flex';
    $id('uploadArea').style.display = 'none';

    updateTableOfContents();
    showToast('文件加载成功！');
}

function removeUploadedFile() {
    if (!store.get('uploadedFileName')) return;
    store.set({ uploadedFileName: null });
    $id('fileInput').value = '';
    $id('fileInfo').style.display = 'none';
    $id('uploadArea').style.display = 'flex';

    if (originalContent) {
        $id('articleTitle').textContent = originalContent.title;
        $id('articleMeta').innerHTML = originalContent.meta;
        $id('articleContent').innerHTML = originalContent.content;
    }
    restoreOriginalToc();
    showToast('已移除上传的文件');
}

function restoreOriginalToc() {
    $id('tocList').innerHTML = `
        <li class="toc-item active" data-section="section1">第一章</li>
        <li class="toc-item" data-section="section2">第二章</li>
        <li class="toc-item" data-section="section3">第三章</li>
        <li class="toc-item" data-section="section4">第四章</li>
        <li class="toc-item" data-section="section5">第五章</li>
    `;
    bindTocClicks();
}

function bindTocClicks() {
    document.querySelectorAll('.toc-item').forEach(item => {
        item.addEventListener('click', () => {
            const section = $id(item.dataset.section);
            if (section) {
                section.scrollIntoView({ behavior: 'smooth' });
                document.querySelectorAll('.toc-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            }
        });
    });
}

function updateTableOfContents() {
    const tocList = $id('tocList');
    const sections = document.querySelectorAll('.content-section');
    if (sections.length === 0) {
        tocList.innerHTML = '<li class="toc-item active" data-section="section1">全文</li>';
        bindTocClicks();
        return;
    }
    let html = '';
    sections.forEach((section, index) => {
        const heading = section.querySelector('h2');
        const title = heading ? heading.textContent : `第${index + 1}节`;
        html += `<li class="toc-item ${index === 0 ? 'active' : ''}" data-section="${section.id}">${escapeHtml(title)}</li>`;
    });
    tocList.innerHTML = html;
    bindTocClicks();
}

function formatTextContent(content) {
    const paragraphs = content.split(/\n+/).filter(p => p.trim());
    let html = '';
    let sectionCount = 0;
    let inSection = false;
    const headingRegex = /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

    paragraphs.forEach(para => {
        para = para.trim();
        if (!para) return;
        if (headingRegex.test(para)) {
            if (inSection) html += '</section>';
            sectionCount++;
            html += `<section id="section${sectionCount}" class="content-section">`;
            html += `<h2>${escapeHtml(para)}</h2>`;
            inSection = true;
        } else if (para.length < 50 && !/[。，！？；：]/.test(para)) {
            html += `<h3>${escapeHtml(para)}</h3>`;
        } else {
            html += `<p>${escapeHtml(para)}</p>`;
        }
    });
    if (inSection) html += '</section>';
    if (sectionCount === 0) {
        html = '<section id="section1" class="content-section">';
        paragraphs.forEach(para => {
            para = para.trim();
            if (para) html += `<p>${escapeHtml(para)}</p>`;
        });
        html += '</section>';
    }
    return html;
}

// 供 shelf.js 调用：从书架打开 TXT 后的渲染
export function displayBookContent(book, content) {
    displayContent(book.originalName || book.original_name, content);
}
