// 应用入口：初始化各模块、视图切换、全局快捷键

import { initAuth } from './auth.js';
import { initReader } from './reader.js';
import { initShelf, loadBooks } from './shelf.js';
import { initAI, closeAIPanel, renderHistory, loadHistory } from './ai.js';
import { initSettings, loadProviders, checkApiKeyStatus } from './settings.js';
import { store } from './store.js';
import { $id } from './utils.js';

function initApp() {
    initReader();
    initShelf();
    initAI();
    initSettings();

    // 视图切换
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // 全局快捷键
    document.addEventListener('keydown', handleKeyboardShortcuts);

    // 加载初始数据
    loadProviders();
    checkApiKeyStatus();
    loadBooks();
    loadHistory();
}

function switchView(view) {
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    ['reader', 'history', 'settings', 'library'].forEach(v => {
        $id(`${v}View`).classList.toggle('active', v === view);
    });
    if (view === 'settings') checkApiKeyStatus();
    if (view === 'library') loadBooks();
    if (view === 'history') renderHistory();
}

function handleKeyboardShortcuts(e) {
    if (e.ctrlKey && e.key === 'Enter') {
        if ($id('aiPanel').classList.contains('open')) {
            $id('askBtn').click();
        }
    }
    if (e.key === 'Escape') {
        closeAIPanel();
        $id('floatingToolbar').classList.remove('visible');
        $id('apiKeyModal').classList.remove('visible');
    }
}

// 启动：先认证，认证通过后初始化应用
document.addEventListener('DOMContentLoaded', () => {
    initAuth(() => {
        // 已登录：初始化主应用
        if (store.get('user')) {
            $id('displayUsername').textContent = store.get('user').username;
            $id('userInfo').style.display = 'flex';
        }
        initApp();
    });
});
