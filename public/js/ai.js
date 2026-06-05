// AI 模块：浮动工具栏、AI 面板、流式问答、历史记录

import { store } from './store.js';
import { ai, history } from './api.js';
import { $, $id, escapeHtml, showToast, formatDate } from './utils.js';

const ACTION_MAP = {
    explain: '请解释这段文字的含义',
    summarize: '请总结这段文字的要点',
    translate: '请将这段文字翻译成英文',
    expand: '请提供与这段文字相关的扩展知识'
};

export function initAI() {
    // 浮动工具栏
    document.addEventListener('mouseup', handleTextSelection);
    document.addEventListener('mousedown', handleMouseDown);

    $id('floatingToolbar').addEventListener('click', (e) => {
        const btn = e.target.closest('.toolbar-btn');
        if (btn) handleToolbarAction(btn.dataset.action);
    });

    // AI 面板
    $id('aiPanel').addEventListener('click', (e) => {
        const btn = e.target.closest('.quick-action-btn');
        if (btn) executeAction(btn.dataset.action);
    });
    $id('askBtn').addEventListener('click', handleAskQuestion);
    $id('questionInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) handleAskQuestion();
    });
    $id('closePanelBtn').addEventListener('click', closeAIPanel);

    // 模态框
    $id('apiKeyModal').addEventListener('click', (e) => {
        if (e.target === $id('apiKeyModal')) hideModal();
    });
}

function handleTextSelection() {
    const toolbar = $id('floatingToolbar');
    const panel = $id('aiPanel');
    setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (text.length > 0 && !toolbar.contains(selection.anchorNode) && !panel.contains(selection.anchorNode)) {
            store.set({ selectedText: text });
            showFloatingToolbar(selection);
        } else {
            hideFloatingToolbar();
        }
    }, 10);
}

function handleMouseDown(e) {
    const toolbar = $id('floatingToolbar');
    const panel = $id('aiPanel');
    if (!toolbar.contains(e.target) && !panel.contains(e.target)) {
        hideFloatingToolbar();
    }
}

function showFloatingToolbar(selection) {
    const toolbar = $id('floatingToolbar');
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    toolbar.style.visibility = 'hidden';
    toolbar.style.display = 'flex';
    const toolbarWidth = toolbar.offsetWidth || 280;
    const toolbarHeight = toolbar.offsetHeight || 45;
    let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
    let top = rect.top - toolbarHeight - 10;
    if (top < 10) top = rect.bottom + 10;
    left = Math.max(10, Math.min(left, window.innerWidth - toolbarWidth - 10));
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    toolbar.style.visibility = 'visible';
    toolbar.classList.add('visible');
}

function hideFloatingToolbar() {
    const toolbar = $id('floatingToolbar');
    toolbar.classList.remove('visible');
    toolbar.style.display = '';
    toolbar.style.visibility = '';
}

function handleToolbarAction(action) {
    if (action === 'ask') {
        openAIPanel();
    } else {
        executeAction(action);
    }
    hideFloatingToolbar();
}

function isProviderConfigured() {
    const apiProviders = store.get('apiProviders');
    const currentProvider = store.get('currentProvider');
    const data = apiProviders[currentProvider];
    return data && data.hasKey;
}

export function showModal() {
    $id('apiKeyModal').classList.add('visible');
    $id('modalApiKeyInput').focus();
}

export function hideModal() {
    $id('apiKeyModal').classList.remove('visible');
    $id('modalApiKeyInput').value = '';
}

export function openAIPanel() {
    $id('selectedTextContent').textContent = store.get('selectedText');
    $id('aiPanel').classList.add('open');
    $id('questionInput').focus();
    $id('responseContent').innerHTML = '<p class="placeholder-text">选中文字后，点击快捷操作或输入问题，AI将为您提供解答。</p>';
}

export function closeAIPanel() {
    $id('aiPanel').classList.remove('open');
}

function executeAction(action) {
    if (!store.get('selectedText')) {
        showToast('请先选中要提问的文本');
        return;
    }
    if (!isProviderConfigured()) {
        showModal();
        return;
    }
    const question = ACTION_MAP[action] || action;
    openAIPanel();
    askAI(question);
}

function handleAskQuestion() {
    const question = $id('questionInput').value.trim();
    if (!question) { showToast('请输入您的问题'); return; }
    if (!store.get('selectedText')) { showToast('请先选中要提问的文本'); return; }
    if (!isProviderConfigured()) { showModal(); return; }
    askAI(question);
}

function getCurrentBookName() {
    const fileName = store.get('uploadedFileName');
    if (fileName) return fileName.replace(/\.[^.]+$/, '');
    const titleEl = $id('articleTitle');
    if (titleEl && titleEl.textContent) return titleEl.textContent.trim();
    return null;
}

async function askAI(question) {
    const askBtn = $id('askBtn');
    askBtn.classList.add('loading');
    askBtn.disabled = true;
    $id('responseContent').innerHTML = '<p class="placeholder-text">🤔 AI正在思考中...</p>';

    let fullContent = '';
    try {
        const { promise } = ai.askStream({
            text: store.get('selectedText'),
            question,
            bookName: getCurrentBookName(),
            provider: store.get('currentProvider'),
            model: store.get('currentModel')
        }, (event) => {
            if (event.type === 'start') {
                $id('responseContent').innerHTML = `<div class="answer-content"></div>`;
                const responseHeader = document.querySelector('.response-header');
                if (responseHeader) {
                    responseHeader.innerHTML = `
                        <span class="response-label">AI回答：</span>
                        <span class="model-tag-inline">🤖 ${escapeHtml(event.provider)} · ${escapeHtml(event.model)}</span>
                    `;
                }
            } else if (event.type === 'chunk') {
                fullContent += event.content;
                const contentEl = $id('responseContent').querySelector('.answer-content');
                if (contentEl) {
                    contentEl.innerHTML = escapeHtml(fullContent).replace(/\n/g, '<br>');
                    contentEl.scrollTop = contentEl.scrollHeight;
                }
            } else if (event.type === 'error') {
                $id('responseContent').innerHTML = `<p style="color:#ef4444;">错误: ${escapeHtml(event.error)}</p>`;
            } else if (event.type === 'end') {
                saveToHistory(store.get('selectedText'), question, fullContent);
            }
        });
        await promise;
    } catch (err) {
        if (err.status === 403 && err.data?.needApiKey) {
            const providerInfo = store.get('providers').find(p => p.id === (err.data.provider || store.get('currentProvider')));
            const name = providerInfo ? providerInfo.name : 'AI';
            $id('responseContent').innerHTML = `
                <div class="api-warning">
                    <span class="api-warning-icon">⚠️</span>
                    <div class="api-warning-text">
                        <strong>需要配置API密钥</strong>
                        请先配置${name}的API密钥以使用AI功能
                    </div>
                </div>
            `;
        } else {
            $id('responseContent').innerHTML = `<p style="color:#ef4444;">错误: ${escapeHtml(err.message)}</p>`;
        }
    } finally {
        askBtn.classList.remove('loading');
        askBtn.disabled = false;
        $id('questionInput').value = '';
    }
}

async function saveToHistory(selectedText, question, answer) {
    const localItem = {
        id: `local-${Date.now()}`,
        text: selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : ''),
        question,
        answer,
        time: new Date().toISOString(),
        _synced: false
    };
    const historyList = [localItem, ...store.get('history')].slice(0, 50);
    store.set({ history: historyList });
    renderHistory();

    // 同步到服务端（失败时保留 _synced=false 标记）
    try {
        const result = await history.add(selectedText, question, answer);
        // 用服务端 id 替换本地临时 id
        const updated = store.get('history').map(h =>
            h.id === localItem.id ? { ...h, id: result.id, _synced: true } : h
        );
        store.set({ history: updated });
        renderHistory();
    } catch (err) {
        console.warn('历史记录保存到服务器失败:', err.message);
    }
}

// 启动时从服务端拉取历史
export async function loadHistory() {
    try {
        const data = await history.list();
        const items = (data.history || []).map(h => ({
            id: h.id,
            text: h.text || '',
            question: h.question,
            answer: h.answer,
            time: h.time,
            _synced: true
        }));
        store.set({ history: items });
        renderHistory();
    } catch (err) {
        console.warn('拉取历史记录失败:', err.message);
    }
}

// 删除单条历史
async function deleteHistoryItem(id) {
    try {
        await history.remove(id);
    } catch (err) {
        console.warn('删除历史记录失败:', err.message);
    }
    store.set({ history: store.get('history').filter(h => h.id !== id) });
    renderHistory();
    showToast('已删除');
}

export function renderHistory() {
    const list = $id('historyList');
    const historyList = store.get('history');
    if (!historyList || historyList.length === 0) {
        list.innerHTML = '<p class="empty-history">暂无历史记录</p>';
        return;
    }
    list.innerHTML = historyList.map(item => `
        <div class="history-item" data-id="${escapeHtml(item.id)}">
            <div class="history-selected-text">${escapeHtml(item.text)}</div>
            <div class="history-question">❓ ${escapeHtml(item.question)}</div>
            <div class="history-answer">${escapeHtml(item.answer)}</div>
            <div class="history-footer">
                <span class="history-time">${escapeHtml(formatDate(item.time))}${item._synced === false ? ' <em class="sync-pending">(同步中)</em>' : ''}</span>
                <button class="history-delete-btn" data-id="${escapeHtml(item.id)}" title="删除">🗑️</button>
            </div>
        </div>
    `).join('');
    list.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            // 数字 id 才调用服务端（"local-*" 是未同步的临时 id）
            if (/^\d+$/.test(String(id))) deleteHistoryItem(id);
            else {
                store.set({ history: store.get('history').filter(h => h.id !== id) });
                renderHistory();
            }
        });
    });
}
