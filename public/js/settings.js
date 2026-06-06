// 设置：API 密钥管理、自定义提供商、模型选择

import { store } from './store.js';
import { providers, keys } from './api.js';
import { $, $id, escapeHtml, showToast, formatDate } from './utils.js';
import { showModal, hideModal } from './ai.js';

const BUILTIN_ICONS = { zhipu: '🤖', siliconflow: '🌊' };
const BUILTIN_INFO = {
    zhipu: {
        hint: '获取API密钥：访问 <a href="https://open.bigmodel.cn/" target="_blank">智谱AI开放平台</a>',
        list: '<li>API密钥将使用AES-256加密存储在本地服务器</li><li>密钥仅用于调用智谱AI服务，不会传输到其他服务器</li><li>您可以随时删除已保存的密钥</li><li>推荐使用 glm-4.5-air 模型，性价比高</li>'
    },
    siliconflow: {
        hint: '获取API密钥：访问 <a href="https://cloud.siliconflow.cn/" target="_blank">硅基流动控制台</a>',
        list: '<li>API密钥将使用AES-256加密存储在本地服务器</li><li>密钥仅用于调用硅基流动服务，不会传输到其他服务器</li><li>您可以随时删除已保存的密钥</li><li>新用户注册即送代金券，默认模型 DeepSeek V4 Flash 性价比极高</li>'
    }
};

export function initSettings() {
    // 提供商 tabs 由 renderProviderTabs 在加载完列表后渲染
    $id('configureApiBtn').addEventListener('click', () => switchToView('settings'));
    $id('toggleVisibilityBtn').addEventListener('click', () => toggleKeyVisibility('apiKeyInput'));
    $id('saveApiKeyBtn').addEventListener('click', saveApiKey);
    $id('verifyApiKeyBtn').addEventListener('click', verifyApiKey);
    $id('deleteApiKeyBtn').addEventListener('click', deleteApiKey);

    $id('addModelBtn').addEventListener('click', addCustomModel);
    $id('customModelId').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addCustomModel(); }
    });

    $id('apiKeyInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveApiKey();
    });

    // 自定义提供商
    $id('addProviderBtn').addEventListener('click', addCustomProvider);
    $id('toggleCustomKeyVisibility').addEventListener('click', () => toggleKeyVisibility('customProviderApiKey'));

    // 模态框
    $id('closeModalBtn').addEventListener('click', hideModal);
    $id('modalCancelBtn').addEventListener('click', hideModal);
    $id('modalSaveBtn').addEventListener('click', saveApiKeyFromModal);
    $id('modalApiKeyInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveApiKeyFromModal();
    });
}

export async function loadProviders() {
    try {
        const data = await providers.list();
        store.set({ providers: data.providers || [] });
        renderProviderTabs();
        switchProvider(store.get('currentProvider'));
    } catch (err) {
        console.error('加载提供商失败:', err);
    }
}

function renderProviderTabs() {
    const builtIn = store.get('providers').filter(p => !p.isCustom);
    let html = builtIn.map(p => `
        <button class="provider-tab ${p.id === store.get('currentProvider') ? 'active' : ''}" data-provider="${p.id}">
            ${BUILTIN_ICONS[p.id] || '🤖'} ${escapeHtml(p.name)}
        </button>
    `).join('');
    html += `<button class="provider-tab" data-provider="custom">➕ 自定义</button>`;
    $id('providerTabs').innerHTML = html;

    $id('providerTabs').querySelectorAll('.provider-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const provider = tab.dataset.provider;
            if (provider === 'custom') showCustomProviderView();
            else switchProvider(provider);
        });
    });
}

export function switchProvider(provider) {
    store.set({ currentProvider: provider });
    const providerInfo = store.get('providers').find(p => p.id === provider);
    if (!providerInfo) return;

    // 高亮 tab
    document.querySelectorAll('.provider-tab').forEach(tab => {
        const isCustom = store.get('providers').find(p => p.id === provider && p.isCustom);
        if (isCustom) {
            tab.classList.toggle('active', tab.dataset.provider === 'custom');
        } else {
            tab.classList.toggle('active', tab.dataset.provider === provider);
        }
    });

    // 显隐区段
    if (providerInfo.isCustom) {
        $('.api-key-form').style.display = 'block';
        $id('customProvidersSection').style.display = 'block';
        $id('addProviderForm').style.display = 'none';
        $id('apiInfoSection').style.display = 'none';
    } else {
        $('.api-key-form').style.display = 'block';
        $id('customProvidersSection').style.display = 'none';
        $id('addProviderForm').style.display = 'none';
        $id('apiInfoSection').style.display = 'block';
    }

    // 标签
    $id('apiKeyLabel').textContent = `${providerInfo.name} API密钥`;
    $id('apiKeyHint').innerHTML = (BUILTIN_INFO[providerInfo.id] || {}).hint || `请输入您的 ${providerInfo.name} API密钥`;

    // 模型下拉
    const models = getProviderModels(providerInfo);
    if (models.length > 0) {
        $id('modelSelectGroup').style.display = 'block';
        // 优先读取该提供商在 localStorage 中独立保存的模型；否则回退到当前内存值
        const savedModel = getSavedModelForProvider(providerInfo.id)
            || store.get('currentModel')
            || providerInfo.defaultModel;
        store.set({ currentModel: savedModel });
        $id('modelSelect').innerHTML = models.map(m =>
            `<option value="${escapeHtml(m.id)}" ${m.id === savedModel ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
        ).join('');
        $id('modelSelect').onchange = (e) => {
            store.set({ currentModel: e.target.value });
            $id('modelValue').textContent = e.target.value;
        };
        $id('modelValue').textContent = savedModel;
    } else {
        $id('modelSelectGroup').style.display = 'none';
    }

    // 使用说明
    if (!providerInfo.isCustom && $id('apiInfoList')) {
        $id('apiInfoList').innerHTML = (BUILTIN_INFO[providerInfo.id] || {}).list ||
            `<li>API密钥将使用AES-256加密存储在本地服务器</li><li>密钥仅用于调用${escapeHtml(providerInfo.name)}服务，不会传输到其他服务器</li><li>您可以随时删除已保存的密钥</li>`;
    }

    $id('apiKeyInput').value = '';
    renderCustomProvidersList();
    renderCustomModelTags(provider);
    checkApiKeyStatus();
}

function getProviderModels(providerInfo) {
    let models = providerInfo.models || [];
    const custom = getCustomModels(providerInfo.id);
    return [...models, ...custom];
}

function getCustomModels(providerId) {
    try {
        return JSON.parse(localStorage.getItem(`customModels_${providerId}`)) || [];
    } catch { return []; }
}

function getSavedModelForProvider(providerId) {
    try {
        return localStorage.getItem(`selectedModel_${providerId}`) || null;
    } catch { return null; }
}

function saveCustomModels(providerId, models) {
    localStorage.setItem(`customModels_${providerId}`, JSON.stringify(models));
}

function addCustomModel() {
    const input = $id('customModelId');
    const modelId = input.value.trim();
    if (!modelId) { showToast('请输入模型ID'); return; }
    const currentProvider = store.get('currentProvider');
    const models = getCustomModels(currentProvider);
    if (models.find(m => m.id === modelId)) { showToast('该模型ID已存在'); return; }
    models.push({ id: modelId, name: modelId });
    saveCustomModels(currentProvider, models);
    input.value = '';
    switchProvider(currentProvider);
    showToast('模型已添加');
}

function renderCustomModelTags(providerId) {
    const models = getCustomModels(providerId);
    const container = $id('customModelTags');
    if (!container) return;
    if (models.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = models.map(m =>
        `<span class="model-tag">${escapeHtml(m.id)} <button data-id="${escapeHtml(m.id)}" class="remove-model-btn">×</button></span>`
    ).join('');
    container.querySelectorAll('.remove-model-btn').forEach(btn => {
        btn.addEventListener('click', () => removeCustomModel(providerId, btn.dataset.id));
    });
}

function removeCustomModel(providerId, modelId) {
    const models = getCustomModels(providerId).filter(m => m.id !== modelId);
    saveCustomModels(providerId, models);
    switchProvider(providerId);
}

function showCustomProviderView() {
    document.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === 'custom'));
    $('.api-key-form').style.display = 'none';
    $id('customProvidersSection').style.display = 'block';
    $id('addProviderForm').style.display = 'block';
    $id('apiInfoSection').style.display = 'none';
}

function renderCustomProvidersList() {
    const list = $id('customProvidersList');
    const customs = store.get('providers').filter(p => p.isCustom);
    if (customs.length === 0) {
        list.innerHTML = '<p class="empty-custom">暂无自定义提供商</p>';
        return;
    }
    list.innerHTML = customs.map(p => `
        <div class="custom-provider-item" data-id="${p.id}">
            <div class="custom-provider-info">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="custom-provider-id">${escapeHtml(p.id)}</span>
            </div>
            <button class="btn btn-sm btn-secondary use-provider-btn" data-id="${p.id}">使用</button>
        </div>
    `).join('');
    list.querySelectorAll('.use-provider-btn').forEach(btn => {
        btn.addEventListener('click', () => switchProvider(btn.dataset.id));
    });
}

async function addCustomProvider() {
    const name = $id('customProviderName').value.trim();
    const endpoint = $id('customProviderEndpoint').value.trim();
    const defaultModel = $id('customProviderModel').value.trim();
    const modelsRaw = $id('customProviderModels').value.trim();
    const apiKey = $id('customProviderApiKey').value.trim();
    const btn = $id('addProviderBtn');

    if (!name || !endpoint || !defaultModel || !apiKey) {
        showToast('请填写所有必填项');
        return;
    }

    let models = null;
    if (modelsRaw) {
        try { models = JSON.parse(modelsRaw); }
        catch { showToast('模型列表 JSON 格式错误'); return; }
    }

    btn.classList.add('loading');
    btn.disabled = true;
    try {
        const data = await providers.add({ name, apiEndpoint: endpoint, defaultModel, models, apiKey });
        showToast('自定义提供商添加成功！');
        // 刷新列表
        await loadProviders();
        // 清空表单
        ['customProviderName', 'customProviderEndpoint', 'customProviderModel', 'customProviderModels', 'customProviderApiKey']
            .forEach(id => $id(id).value = '');
    } catch (err) {
        showToast(err.message || '添加失败');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}

export async function checkApiKeyStatus() {
    const indicator = document.querySelector('.status-indicator');
    const text = document.querySelector('.status-text');
    const value = $id('keyStatusValue');
    indicator.className = 'status-indicator checking';
    text.textContent = '检查中...';
    if (value) { value.textContent = '检查中...'; value.className = 'status-value'; }

    try {
        const data = await keys.status();
        store.set({ apiProviders: data.providers || {} });
        const currentProvider = store.get('currentProvider');
        const providerData = store.get('apiProviders')[currentProvider] || {};

        if (providerData.hasKey) {
            indicator.className = 'status-indicator active';
            text.textContent = '已配置';
            if (value) { value.textContent = '已配置'; value.className = 'status-value connected'; }
            $id('maskedKeyRow').style.display = 'flex';
            $id('maskedKeyValue').textContent = providerData.maskedKey;
            if (providerData.lastUpdated) {
                $id('lastUpdatedRow').style.display = 'flex';
                $id('lastUpdatedValue').textContent = formatDate(providerData.lastUpdated);
            }
            $id('deleteApiKeyBtn').style.display = 'inline-flex';
            const providerInfo = store.get('providers').find(p => p.id === currentProvider);
            if (providerInfo) {
                $id('modelRow').style.display = 'flex';
                $id('modelValue').textContent = store.get('currentModel') || providerInfo.defaultModel;
            }
        } else {
            indicator.className = 'status-indicator inactive';
            text.textContent = '未配置';
            if (value) { value.textContent = '未配置'; value.className = 'status-value disconnected'; }
            ['maskedKeyRow', 'lastUpdatedRow', 'deleteApiKeyBtn', 'modelRow'].forEach(id => {
                if ($id(id)) $id(id).style.display = 'none';
            });
        }
    } catch (err) {
        indicator.className = 'status-indicator inactive';
        text.textContent = '检查失败';
        if (value) { value.textContent = '检查失败'; value.className = 'status-value disconnected'; }
    }
}

function toggleKeyVisibility(inputId) {
    const input = $id(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function saveApiKey() {
    const input = $id('apiKeyInput');
    const apiKey = input.value.trim();
    if (!apiKey) { showToast('请输入API密钥'); return; }
    const btn = $id('saveApiKeyBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
        await keys.set(apiKey, store.get('currentProvider'));
        showToast('API密钥保存成功！');
        input.value = '';
        checkApiKeyStatus();
    } catch (err) {
        showToast(err.message || '保存失败');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}

async function verifyApiKey() {
    const btn = $id('verifyApiKeyBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
        const data = await keys.verify(store.get('currentProvider'));
        showToast(data.valid ? 'API密钥验证成功！' : (data.error || 'API密钥无效'));
    } catch (err) {
        showToast(err.message || '验证失败');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}

async function deleteApiKey() {
    const providerInfo = store.get('providers').find(p => p.id === store.get('currentProvider'));
    const name = providerInfo ? providerInfo.name : '';
    if (!confirm(`确定要删除已保存的${name}API密钥吗？`)) return;
    try {
        await keys.remove(store.get('currentProvider'));
        showToast('API密钥已删除');
        checkApiKeyStatus();
    } catch (err) {
        showToast(err.message || '删除失败');
    }
}

async function saveApiKeyFromModal() {
    const input = $id('modalApiKeyInput');
    const apiKey = input.value.trim();
    if (!apiKey) { showToast('请输入API密钥'); return; }
    const btn = $id('modalSaveBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
        await keys.set(apiKey, store.get('currentProvider'));
        showToast('API密钥配置成功！');
        hideModal();
        checkApiKeyStatus();
    } catch (err) {
        showToast(err.message || '配置失败');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}

function switchToView(view) {
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-view="${view}"]`).classList.add('active');
    ['reader', 'history', 'settings', 'library'].forEach(v => {
        $id(`${v}View`).classList.toggle('active', v === view);
    });
}
