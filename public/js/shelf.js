// 书架：列表、上传、下载、删除、打开 TXT

import { store } from './store.js';
import { books } from './api.js';
import { $, $id, escapeHtml, showToast, formatFileSize } from './utils.js';
import { displayBookContent } from './reader.js';

const ALLOWED_EXTS = ['.txt', '.pdf', '.epub', '.mobi'];
const MAX_SIZE = 50 * 1024 * 1024;

export function initShelf() {
    const uploadCard = $id('uploadCard');
    const bookFileInput = $id('bookFileInput');
    const uploadBookBtn = $id('uploadBookBtn');

    uploadCard.addEventListener('click', (e) => {
        if (e.target !== uploadBookBtn) bookFileInput.click();
    });
    uploadBookBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        bookFileInput.click();
    });
    bookFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) uploadBook(e.target.files[0]);
    });

    uploadCard.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadCard.style.borderColor = 'var(--primary-color)';
        uploadCard.style.background = 'var(--bg-secondary)';
    });
    uploadCard.addEventListener('dragleave', () => {
        uploadCard.style.borderColor = '';
        uploadCard.style.background = '';
    });
    uploadCard.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadCard.style.borderColor = '';
        uploadCard.style.background = '';
        if (e.dataTransfer.files.length > 0) uploadBook(e.dataTransfer.files[0]);
    });
}

export async function loadBooks() {
    try {
        const data = await books.list();
        store.set({ books: data.books || [] });
        renderBooks();
    } catch (err) {
        console.error('加载书架失败:', err);
    }
}

async function uploadBook(file) {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
        showToast(`不支持的文件格式。支持: ${ALLOWED_EXTS.join(', ')}`);
        return;
    }
    if (file.size > MAX_SIZE) {
        showToast('文件大小超过限制（最大50MB）');
        return;
    }

    const progress = $id('uploadProgress');
    const progressFill = $id('progressFill');
    const progressText = $id('progressText');
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = '准备上传...';

    try {
        const data = await books.upload(file, (percent) => {
            progressFill.style.width = `${percent}%`;
            progressText.textContent = `上传中... ${percent}%`;
        });
        showToast('书籍上传成功！');
        const newBooks = [data.book, ...store.get('books')];
        store.set({ books: newBooks });
        renderBooks();
        $id('bookFileInput').value = '';
    } catch (err) {
        showToast(err.message || '上传失败');
    } finally {
        progress.style.display = 'none';
    }
}

function renderBooks() {
    const booksGrid = $id('booksGrid');
    const libraryStats = $id('libraryStats');
    const list = store.get('books');
    libraryStats.innerHTML = `共 <strong>${list.length}</strong> 本书`;

    if (list.length === 0) {
        booksGrid.innerHTML = `
            <div class="empty-library">
                <div class="empty-icon">📖</div>
                <p>书架空空如也</p>
                <p class="empty-hint">上传您的第一本书籍开始阅读吧</p>
            </div>
        `;
        return;
    }

    booksGrid.innerHTML = list.map(renderBookCard).join('');

    booksGrid.querySelectorAll('.book-card').forEach(card => {
        const bookId = card.dataset.bookId;
        card.querySelector('.read-btn').addEventListener('click', (e) => { e.stopPropagation(); openBook(bookId); });
        card.querySelector('.download-btn').addEventListener('click', (e) => { e.stopPropagation(); downloadBook(bookId); });
        card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteBook(bookId); });
    });
}

function renderBookCard(book) {
    const formatIcons = { TXT: '📄', PDF: '📕', EPUB: '📘', MOBI: '📙' };
    const icon = formatIcons[book.format] || '📖';
    const uploadDate = new Date(book.uploadTime || book.upload_time).toLocaleDateString('zh-CN');
    const sizeFormatted = book.sizeFormatted || book.size_formatted;
    return `
        <div class="book-card" data-book-id="${book.id}">
            <div class="book-cover">
                <span class="book-icon">${icon}</span>
                <span class="book-format">${book.format}</span>
            </div>
            <div class="book-info">
                <div class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>
                <div class="book-meta">
                    <div class="book-meta-item">📁 ${sizeFormatted}</div>
                    <div class="book-meta-item">📅 ${uploadDate}</div>
                </div>
            </div>
            <div class="book-actions">
                <button class="book-action-btn read-btn">📖 阅读</button>
                <button class="book-action-btn download download-btn">⬇️</button>
                <button class="book-action-btn delete delete-btn">🗑️</button>
            </div>
        </div>
    `;
}

async function openBook(bookId) {
    try {
        const data = await books.get(bookId);
        const book = data.book;
        if (book.format.toLowerCase() === 'txt' && data.content) {
            displayBookContent(book, data.content);
            // 切换到阅读视图
            document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector('[data-view="reader"]').classList.add('active');
            switchView('reader');
            showToast(`正在阅读: ${book.title}`);
        } else {
            showToast('该格式书籍暂不支持在线阅读，请下载后使用专业阅读器打开');
        }
    } catch (err) {
        showToast(err.message || '打开书籍失败');
    }
}

async function downloadBook(bookId) {
    const book = store.get('books').find(b => b.id === bookId);
    if (!book) return;
    try {
        const response = await fetch(`/api/books/${bookId}/download`, {
            headers: { 'Authorization': `Bearer ${store.get('token')}` }
        });
        if (!response.ok) throw new Error('下载失败');

        // 从 Content-Disposition 解析服务器给出的原始文件名
        let filename = book.originalName || book.original_name || 'download';
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (match) {
            try { filename = decodeURIComponent(match[1]); } catch (_) { filename = match[1]; }
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // 稍后释放 URL，确保浏览器已开始下载
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
        showToast(err.message || '下载失败');
    }
}

async function deleteBook(bookId) {
    const book = store.get('books').find(b => b.id === bookId);
    if (!book) return;
    if (!confirm(`确定要删除《${book.title}》吗？\n删除后文件将无法恢复。`)) return;
    try {
        await books.remove(bookId);
        showToast('书籍已删除');
        store.set({ books: store.get('books').filter(b => b.id !== bookId) });
        renderBooks();
    } catch (err) {
        showToast(err.message || '删除失败');
    }
}

// 视图切换辅助（与 main.js 中的 switchView 协同）
function switchView(view) {
    ['reader', 'history', 'settings', 'library'].forEach(v => {
        $id(`${v}View`).classList.toggle('active', v === view);
    });
}
