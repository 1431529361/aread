// 通用工具：HTML 转义、Toast、DOM 助手

export function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

let toastTimer = null;
export function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

export function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(isoString) {
    if (!isoString) return '';
    return new Date(isoString).toLocaleString('zh-CN');
}

// 切换元素显隐
export function show(el) { if (el) el.style.display = ''; }
export function hide(el) { if (el) el.style.display = 'none'; }

// 简单的查询选择器（缩短常用调用）
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);
export const $id = (id) => document.getElementById(id);