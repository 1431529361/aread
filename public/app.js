class AIReadingAssistant {
    constructor() {
        this.selectedText = '';
        this.history = [];
        this.currentFontSize = 18;
        this.currentTheme = 'light';
        this.apiProviders = {};
        this.currentProvider = localStorage.getItem('selectedProvider') || 'zhipu';
        this.currentModel = localStorage.getItem(`selectedModel_${this.currentProvider}`) || null;
        this.uploadedFileName = null;
        this.originalContent = null;
        this.books = [];
        this.providers = [];

        this.token = localStorage.getItem('authToken') || null;
        this.currentUser = null;
        this.isAuthenticated = false;
        this.authMode = 'login';

        this.initElements();
        this.initAuthListeners();

        if (this.token) {
            this.validateToken();
        } else {
            this.showAuthScreen();
        }
    }

    // ==================== Auth ====================

    initAuthListeners() {
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.authMode = e.currentTarget.dataset.tab;
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                e.currentTarget.classList.add('active');

                const rememberGroup = document.getElementById('rememberMeGroup');
                rememberGroup.style.display = this.authMode === 'login' ? 'flex' : 'none';

                const submitBtn = document.getElementById('authSubmitBtn');
                submitBtn.querySelector('.btn-text').textContent = this.authMode === 'login' ? '登录' : '注册';

                document.getElementById('authError').textContent = '';
            });
        });

        document.getElementById('authForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAuthSubmit();
        });

        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });
    }

    async handleAuthSubmit() {
        const username = document.getElementById('authUsername').value.trim();
        const password = document.getElementById('authPassword').value;
        const rememberMe = document.getElementById('rememberMe').checked;
        const errorEl = document.getElementById('authError');
        const submitBtn = document.getElementById('authSubmitBtn');

        if (!username) {
            errorEl.textContent = '请输入用户名';
            return;
        }
        if (!password || password.length < 6) {
            errorEl.textContent = '密码至少6位';
            return;
        }

        errorEl.textContent = '';
        submitBtn.classList.add('loading');
        submitBtn.disabled = true;

        try {
            const endpoint = this.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const body = this.authMode === 'login'
                ? { username, password, rememberMe }
                : { username, password };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await res.json();

            if (res.ok) {
                this.token = data.token;
                this.currentUser = data.user;
                localStorage.setItem('authToken', data.token);
                this.isAuthenticated = true;
                this.hideAuthScreen();
                this.initApp();
            } else {
                errorEl.textContent = data.error || '操作失败';
            }
        } catch (error) {
            errorEl.textContent = '网络错误，请检查服务器连接';
        } finally {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
        }
    }

    async validateToken() {
        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (res.ok) {
                const data = await res.json();
                this.currentUser = data.user;
                this.isAuthenticated = true;
                this.hideAuthScreen();
                this.initApp();
            } else {
                this.logout();
            }
        } catch {
            this.showAuthScreen();
        }
    }

    showAuthScreen() {
        document.getElementById('authOverlay').classList.add('visible');
    }

    hideAuthScreen() {
        document.getElementById('authOverlay').classList.remove('visible');
    }

    logout() {
        this.token = null;
        this.currentUser = null;
        this.isAuthenticated = false;
        localStorage.removeItem('authToken');
        document.getElementById('userInfo').style.display = 'none';
        document.getElementById('authUsername').value = '';
        document.getElementById('authPassword').value = '';
        document.getElementById('authError').textContent = '';
        this.showAuthScreen();
    }

    initApp() {
        if (this.currentUser) {
            document.getElementById('displayUsername').textContent = this.currentUser.username;
            document.getElementById('userInfo').style.display = 'flex';
        }

        this.initEventListeners();
        this.loadProviders();
        this.checkApiKeyStatus();
        this.loadHistory();
        this.saveOriginalContent();
        this.loadBooks();
    }

    // ==================== API Fetch Wrapper ====================

    async apiFetch(url, options = {}) {
        if (!options.headers) options.headers = {};
        options.headers['Authorization'] = `Bearer ${this.token}`;

        if (options.body && !(options.body instanceof FormData)) {
            if (!options._skipContentType) {
                options.headers['Content-Type'] = 'application/json';
            }
        }

        const response = await fetch(url, options);

        if (response.status === 401) {
            this.logout();
            throw new Error('登录已过期');
        }

        return response;
    }

    // ==================== Original Init ====================

    saveOriginalContent() {
        this.originalContent = {
            title: document.getElementById('articleTitle').textContent,
            meta: document.getElementById('articleMeta').innerHTML,
            content: document.getElementById('articleContent').innerHTML
        };
    }

    initElements() {
        this.articleContent = document.getElementById('articleContent');
        this.floatingToolbar = document.getElementById('floatingToolbar');
        this.aiPanel = document.getElementById('aiPanel');
        this.selectedTextContent = document.getElementById('selectedTextContent');
        this.questionInput = document.getElementById('questionInput');
        this.askBtn = document.getElementById('askBtn');
        this.responseContent = document.getElementById('responseContent');
        this.toast = document.getElementById('toast');
        this.historyList = document.getElementById('historyList');
        this.apiKeyModal = document.getElementById('apiKeyModal');
        this.providerTabs = document.getElementById('providerTabs');
        this.apiKeyLabel = document.getElementById('apiKeyLabel');
        this.apiKeyHint = document.getElementById('apiKeyHint');
        this.modelSelectGroup = document.getElementById('modelSelectGroup');
        this.modelSelect = document.getElementById('modelSelect');
        this.modelRow = document.getElementById('modelRow');
        this.modelValue = document.getElementById('modelValue');
        this.apiInfoList = document.getElementById('apiInfoList');
    }

    async loadProviders() {
        try {
            const response = await this.apiFetch('/api/providers');
            const data = await response.json();
            this.providers = data.providers || [];
            this.renderProviderTabs();
            this.switchProvider(this.currentProvider);
        } catch (error) {
            console.error('加载提供商列表失败:', error);
        }
    }

    renderProviderTabs() {
        const builtInIcons = { zhipu: '🤖', siliconflow: '🌊' };
        let tabsHtml = this.providers.filter(p => !p.isCustom).map(p =>
            `<button class="provider-tab ${p.id === this.currentProvider ? 'active' : ''}" data-provider="${p.id}">${builtInIcons[p.id] || '🤖'} ${p.name}</button>`
        ).join('');

        tabsHtml += `<button class="provider-tab" data-provider="custom">➕ 自定义</button>`;

        this.providerTabs.innerHTML = tabsHtml;

        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const provider = e.currentTarget.dataset.provider;
                if (provider === 'custom') {
                    this.showCustomProviderView();
                } else {
                    this.switchProvider(provider);
                }
            });
        });
    }

    switchProvider(provider) {
        this.currentProvider = provider;
        this.currentModel = localStorage.getItem(`selectedModel_${provider}`) || null;
        localStorage.setItem('selectedProvider', provider);

        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            const isCustomProvider = this.providers.find(p => p.id === provider && p.isCustom);
            if (isCustomProvider) {
                tab.classList.toggle('active', tab.dataset.provider === 'custom');
            } else {
                tab.classList.toggle('active', tab.dataset.provider === provider);
            }
        });

        const providerInfo = this.providers.find(p => p.id === provider);
        if (!providerInfo) return;

        if (providerInfo.isCustom) {
            document.querySelector('.api-key-form').style.display = 'block';
            document.getElementById('customProvidersSection').style.display = 'block';
            document.getElementById('addProviderForm').style.display = 'none';
            document.getElementById('apiInfoSection').style.display = 'none';
        } else {
            document.querySelector('.api-key-form').style.display = 'block';
            document.getElementById('customProvidersSection').style.display = 'none';
            document.getElementById('addProviderForm').style.display = 'none';
            document.getElementById('apiInfoSection').style.display = 'block';
        }

        if (this.apiKeyLabel) {
            this.apiKeyLabel.textContent = `${providerInfo.name} API密钥`;
        }
        if (this.apiKeyHint) {
            if (providerInfo.id === 'zhipu') {
                this.apiKeyHint.innerHTML = `获取API密钥：访问 <a href="https://open.bigmodel.cn/" target="_blank">智谱AI开放平台</a>`;
            } else if (providerInfo.id === 'siliconflow') {
                this.apiKeyHint.innerHTML = `获取API密钥：访问 <a href="https://cloud.siliconflow.cn/" target="_blank">硅基流动控制台</a>`;
            } else {
                this.apiKeyHint.innerHTML = `请输入您的 ${providerInfo.name} API密钥`;
            }
        }
        if (this.modelSelectGroup) {
            const models = this.getProviderModels(providerInfo);
            if (models.length > 0) {
                this.modelSelectGroup.style.display = 'block';
                const savedModel = this.currentModel || providerInfo.defaultModel;
                this.currentModel = savedModel;
                this.modelSelect.innerHTML = models.map(m =>
                    `<option value="${m.id}" ${m.id === savedModel ? 'selected' : ''}>${m.name}</option>`
                ).join('');
                this.modelSelect.onchange = (e) => {
                    this.currentModel = e.target.value;
                    localStorage.setItem(`selectedModel_${provider}`, e.target.value);
                    if (this.modelValue) this.modelValue.textContent = e.target.value;
                };
                if (this.modelValue) this.modelValue.textContent = savedModel;
            } else {
                this.modelSelectGroup.style.display = 'none';
            }
        }
        if (this.apiInfoList && !providerInfo.isCustom) {
            if (providerInfo.id === 'zhipu') {
                this.apiInfoList.innerHTML = `
                    <li>API密钥将使用AES-256加密存储在本地服务器</li>
                    <li>密钥仅用于调用智谱AI服务，不会传输到其他服务器</li>
                    <li>您可以随时删除已保存的密钥</li>
                    <li>推荐使用 glm-4.5-air 模型，性价比高</li>
                `;
            } else if (providerInfo.id === 'siliconflow') {
                this.apiInfoList.innerHTML = `
                    <li>API密钥将使用AES-256加密存储在本地服务器</li>
                    <li>密钥仅用于调用硅基流动服务，不会传输到其他服务器</li>
                    <li>您可以随时删除已保存的密钥</li>
                    <li>新用户注册即送代金券，默认模型 DeepSeek V4 Flash 性价比极高</li>
                `;
            } else {
                this.apiInfoList.innerHTML = `
                    <li>API密钥将使用AES-256加密存储在本地服务器</li>
                    <li>密钥仅用于调用${providerInfo.name}服务，不会传输到其他服务器</li>
                    <li>您可以随时删除已保存的密钥</li>
                `;
            }
        }

        const apiKeyInput = document.getElementById('apiKeyInput');
        if (apiKeyInput) apiKeyInput.value = '';

        this.renderCustomProvidersList();
        this.renderCustomModelTags(provider);
        this.checkApiKeyStatus();
    }

    getCustomModels(providerId) {
        try {
            return JSON.parse(localStorage.getItem(`customModels_${providerId}`)) || [];
        } catch { return []; }
    }

    saveCustomModels(providerId, models) {
        localStorage.setItem(`customModels_${providerId}`, JSON.stringify(models));
    }

    addCustomModel() {
        const input = document.getElementById('customModelId');
        const modelId = input.value.trim();
        if (!modelId) { this.showToast('请输入模型ID'); return; }

        const providerId = this.currentProvider;
        const customModels = this.getCustomModels(providerId);
        if (customModels.some(m => m.id === modelId)) {
            this.showToast('该模型已存在');
            return;
        }
        const providerInfo = this.providers.find(p => p.id === providerId);
        const builtInModels = providerInfo?.models || [];
        if (builtInModels.some(m => m.id === modelId) || providerInfo?.defaultModel === modelId) {
            this.showToast('该模型已在默认列表中');
            return;
        }

        customModels.push({ id: modelId, name: modelId });
        this.saveCustomModels(providerId, customModels);
        input.value = '';
        this.showToast(`已添加模型: ${modelId}`);
        this.switchProvider(providerId);
    }

    removeCustomModel(providerId, modelId) {
        let customModels = this.getCustomModels(providerId);
        customModels = customModels.filter(m => m.id !== modelId);
        this.saveCustomModels(providerId, customModels);
        if (this.currentModel === modelId) {
            const providerInfo = this.providers.find(p => p.id === providerId);
            this.currentModel = providerInfo?.defaultModel || null;
            localStorage.setItem(`selectedModel_${providerId}`, this.currentModel || '');
        }
        this.switchProvider(providerId);
    }

    renderCustomModelTags(providerId) {
        const container = document.getElementById('customModelTags');
        if (!container) return;
        const customModels = this.getCustomModels(providerId);
        if (customModels.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = customModels.map(m =>
            `<span class="model-tag">${this.escapeHtml(m.name)}<button class="tag-remove" data-model-id="${this.escapeHtml(m.id)}" title="删除">×</button></span>`
        ).join('');
        container.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => this.removeCustomModel(providerId, btn.dataset.modelId));
        });
    }

    getProviderModels(providerInfo) {
        const models = [];
        const addedIds = new Set();
        if (providerInfo.defaultModel) {
            models.push({ id: providerInfo.defaultModel, name: providerInfo.defaultModel });
            addedIds.add(providerInfo.defaultModel);
        }
        if (providerInfo.models && providerInfo.models.length > 0) {
            providerInfo.models.forEach(m => {
                if (!addedIds.has(m.id)) {
                    models.push(m);
                    addedIds.add(m.id);
                }
            });
        }
        const customModels = this.getCustomModels(providerInfo.id);
        customModels.forEach(m => {
            if (!addedIds.has(m.id)) {
                models.push(m);
                addedIds.add(m.id);
            }
        });
        return models;
    }

    showCustomProviderView() {
        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.provider === 'custom');
        });
        document.querySelector('.api-key-form').style.display = 'none';
        document.getElementById('apiInfoSection').style.display = 'none';
        document.getElementById('customProvidersSection').style.display = 'block';
        document.getElementById('addProviderForm').style.display = 'block';
        this.renderCustomProvidersList();
        this.checkApiKeyStatus();
    }

    showCustomProviderSettings(providerId) {
        const providerInfo = this.providers.find(p => p.id === providerId);
        if (!providerInfo) return;

        this.currentProvider = providerId;
        this.currentModel = localStorage.getItem(`selectedModel_${providerId}`) || null;
        localStorage.setItem('selectedProvider', providerId);

        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.provider === 'custom');
        });

        document.querySelector('.api-key-form').style.display = 'block';
        document.getElementById('customProvidersSection').style.display = 'block';
        document.getElementById('addProviderForm').style.display = 'none';
        document.getElementById('apiInfoSection').style.display = 'none';

        if (this.apiKeyLabel) this.apiKeyLabel.textContent = `${providerInfo.name} API密钥`;
        if (this.apiKeyHint) this.apiKeyHint.innerHTML = `请输入您的 ${providerInfo.name} API密钥`;
        if (this.modelSelectGroup) {
            const models = this.getProviderModels(providerInfo);
            if (models.length > 0) {
                this.modelSelectGroup.style.display = 'block';
                const savedModel = this.currentModel || providerInfo.defaultModel;
                this.modelSelect.innerHTML = models.map(m =>
                    `<option value="${m.id}" ${m.id === savedModel ? 'selected' : ''}>${m.name}</option>`
                ).join('');
                this.modelSelect.onchange = (e) => {
                    this.currentModel = e.target.value;
                    localStorage.setItem(`selectedModel_${providerId}`, e.target.value);
                    if (this.modelValue) this.modelValue.textContent = e.target.value;
                };
                if (this.modelValue) this.modelValue.textContent = savedModel;
            } else {
                this.modelSelectGroup.style.display = 'none';
            }
        }

        this.renderCustomProvidersList();
        this.checkApiKeyStatus();
    }

    renderCustomProvidersList() {
        const container = document.getElementById('customProvidersList');
        const customProviders = this.providers.filter(p => p.isCustom);

        if (customProviders.length === 0) {
            container.innerHTML = '<p class="empty-custom">暂无自定义提供商</p>';
            return;
        }

        container.innerHTML = customProviders.map(p => {
            const isActive = p.id === this.currentProvider;
            const selectedModel = this.currentModel || p.defaultModel;
            const models = this.getProviderModels(p);
            let modelSelector = '';
            if (models.length > 0) {
                modelSelector = `
                    <div class="model-selector-inline">
                        <label>选择模型：</label>
                        <select class="custom-model-select" data-provider-id="${p.id}">
                            ${models.map(m => `<option value="${m.id}" ${m.id === selectedModel ? 'selected' : ''}>${m.name}</option>`).join('')}
                        </select>
                    </div>
                `;
            }
            return `
                <div class="custom-provider-item ${isActive ? 'active' : ''}" data-provider-id="${p.id}">
                    <div class="custom-provider-info">
                        <div class="custom-provider-name">${this.escapeHtml(p.name)}</div>
                        <div class="custom-provider-id">ID: ${p.id}</div>
                        <div class="custom-provider-model">默认模型: ${this.escapeHtml(p.defaultModel)}</div>
                        ${modelSelector}
                    </div>
                    <div class="custom-provider-actions">
                        <button class="btn btn-primary select-provider-btn" data-provider="${p.id}">选择</button>
                        <button class="btn btn-danger delete-provider-btn" data-provider="${p.id}">删除</button>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.select-provider-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.showCustomProviderSettings(e.currentTarget.dataset.provider);
            });
        });

        container.querySelectorAll('.delete-provider-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.deleteCustomProvider(e.currentTarget.dataset.provider);
            });
        });

        container.querySelectorAll('.custom-model-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const providerId = e.currentTarget.dataset.providerId;
                this.currentProvider = providerId;
                this.currentModel = e.target.value;
                localStorage.setItem('selectedProvider', providerId);
                localStorage.setItem(`selectedModel_${providerId}`, e.target.value);
            });
        });
    }

    async addCustomProvider() {
        const name = document.getElementById('customProviderName').value.trim();
        const apiEndpoint = document.getElementById('customProviderEndpoint').value.trim();
        const defaultModel = document.getElementById('customProviderModel').value.trim();
        const modelsStr = document.getElementById('customProviderModels').value.trim();
        const apiKey = document.getElementById('customProviderApiKey').value.trim();

        if (!name || !apiEndpoint || !defaultModel || !apiKey) {
            this.showToast('请填写所有必填项');
            return;
        }

        let models = null;
        if (modelsStr) {
            try {
                models = JSON.parse(modelsStr);
                if (!Array.isArray(models)) { this.showToast('模型列表必须是JSON数组格式'); return; }
            } catch (e) { this.showToast('模型列表JSON格式错误'); return; }
        }

        const btn = document.getElementById('addProviderBtn');
        btn.classList.add('loading');
        btn.disabled = true;

        try {
            const response = await this.apiFetch('/api/providers', {
                method: 'POST',
                body: JSON.stringify({ name, apiEndpoint, defaultModel, models, apiKey })
            });

            const data = await response.json();

            if (response.ok) {
                this.showToast('自定义提供商添加成功！');
                document.getElementById('customProviderName').value = '';
                document.getElementById('customProviderEndpoint').value = '';
                document.getElementById('customProviderModel').value = '';
                document.getElementById('customProviderModels').value = '';
                document.getElementById('customProviderApiKey').value = '';
                await this.loadProviders();
                this.renderCustomProvidersList();
            } else {
                this.showToast(data.error || '添加失败');
            }
        } catch (error) {
            console.error('添加自定义提供商失败:', error);
            this.showToast('添加失败，请检查网络连接');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    async deleteCustomProvider(providerId) {
        const provider = this.providers.find(p => p.id === providerId);
        if (!provider) return;
        if (!confirm(`确定要删除自定义提供商 "${provider.name}" 吗？\n删除后该提供商的API密钥也将被清除。`)) return;

        try {
            const response = await this.apiFetch(`/api/providers/${providerId}`, { method: 'DELETE' });
            const data = await response.json();

            if (data.success) {
                this.showToast('自定义提供商已删除');
                if (this.currentProvider === providerId) {
                    this.currentProvider = 'zhipu';
                    localStorage.setItem('selectedProvider', 'zhipu');
                }
                await this.loadProviders();
                this.renderCustomProvidersList();
                this.checkApiKeyStatus();
            } else {
                this.showToast(data.error || '删除失败');
            }
        } catch (error) {
            console.error('删除自定义提供商失败:', error);
            this.showToast('删除失败，请检查网络连接');
        }
    }

    initEventListeners() {
        document.addEventListener('mouseup', (e) => this.handleTextSelection(e));
        document.addEventListener('mousedown', (e) => this.handleMouseDown(e));

        document.getElementById('floatingToolbar').addEventListener('click', (e) => {
            const btn = e.target.closest('.toolbar-btn');
            if (btn) this.handleToolbarAction({ currentTarget: btn });
        });

        document.getElementById('aiPanel').addEventListener('click', (e) => {
            const btn = e.target.closest('.quick-action-btn');
            if (btn) this.handleQuickAction({ currentTarget: btn });
        });

        this.askBtn.addEventListener('click', () => this.handleAskQuestion());
        this.questionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) this.handleAskQuestion();
        });

        document.getElementById('closePanelBtn').addEventListener('click', () => this.closeAIPanel());

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e));
        });

        document.getElementById('clearHistoryBtn').addEventListener('click', () => this.clearHistory());

        document.querySelectorAll('.toc-item').forEach(item => {
            item.addEventListener('click', (e) => this.scrollToSection(e));
        });

        document.getElementById('decreaseFont').addEventListener('click', () => this.changeFontSize(-2));
        document.getElementById('increaseFont').addEventListener('click', () => this.changeFontSize(2));

        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.changeTheme(e));
        });

        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        this.initApiKeyListeners();
        this.initFileUploadListeners();
        this.initLibraryListeners();
        this.initCustomProviderListeners();
    }

    initCustomProviderListeners() {
        document.getElementById('addProviderBtn').addEventListener('click', () => this.addCustomProvider());
        document.getElementById('toggleCustomKeyVisibility').addEventListener('click', () => this.toggleKeyVisibility('customProviderApiKey'));
    }

    initLibraryListeners() {
        const uploadCard = document.getElementById('uploadCard');
        const bookFileInput = document.getElementById('bookFileInput');
        const uploadBookBtn = document.getElementById('uploadBookBtn');

        uploadCard.addEventListener('click', (e) => {
            if (e.target !== uploadBookBtn) bookFileInput.click();
        });

        uploadBookBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            bookFileInput.click();
        });

        bookFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this.uploadBook(e.target.files[0]);
        });

        uploadCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadCard.style.borderColor = 'var(--primary-color)';
            uploadCard.style.background = 'var(--bg-secondary)';
        });

        uploadCard.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadCard.style.borderColor = '';
            uploadCard.style.background = '';
        });

        uploadCard.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadCard.style.borderColor = '';
            uploadCard.style.background = '';
            const files = e.dataTransfer.files;
            if (files.length > 0) this.uploadBook(files[0]);
        });
    }

    async loadBooks() {
        try {
            const response = await this.apiFetch('/api/books');
            const data = await response.json();
            this.books = data.books || [];
            this.renderBooks();
        } catch (error) {
            console.error('加载书籍列表失败:', error);
        }
    }

    async uploadBook(file) {
        const allowedExts = ['.txt', '.pdf', '.epub', '.mobi'];
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

        if (!allowedExts.includes(ext)) {
            this.showToast(`不支持的文件格式。支持: ${allowedExts.join(', ')}`);
            return;
        }

        const maxSize = 50 * 1024 * 1024;
        if (file.size > maxSize) {
            this.showToast('文件大小超过限制（最大50MB）');
            return;
        }

        const uploadProgress = document.getElementById('uploadProgress');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        uploadProgress.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '准备上传...';

        const formData = new FormData();
        formData.append('book', file);

        try {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = `${percent}%`;
                    progressText.textContent = `上传中... ${percent}%`;
                }
            });

            xhr.addEventListener('load', () => {
                uploadProgress.style.display = 'none';

                if (xhr.status === 200) {
                    const data = JSON.parse(xhr.responseText);
                    this.showToast('书籍上传成功！');
                    this.books.unshift(data.book);
                    this.renderBooks();
                    document.getElementById('bookFileInput').value = '';
                } else if (xhr.status === 401) {
                    this.logout();
                } else {
                    const error = JSON.parse(xhr.responseText);
                    this.showToast(error.error || '上传失败');
                }
            });

            xhr.addEventListener('error', () => {
                uploadProgress.style.display = 'none';
                this.showToast('上传失败，请检查网络连接');
            });

            xhr.open('POST', '/api/books/upload');
            xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
            xhr.send(formData);
        } catch (error) {
            uploadProgress.style.display = 'none';
            console.error('上传失败:', error);
            this.showToast('上传失败，请重试');
        }
    }

    renderBooks() {
        const booksGrid = document.getElementById('booksGrid');
        const libraryStats = document.getElementById('libraryStats');

        libraryStats.innerHTML = `共 <strong>${this.books.length}</strong> 本书`;

        if (this.books.length === 0) {
            booksGrid.innerHTML = `
                <div class="empty-library">
                    <div class="empty-icon">📖</div>
                    <p>书架空空如也</p>
                    <p class="empty-hint">上传您的第一本书籍开始阅读吧</p>
                </div>
            `;
            return;
        }

        booksGrid.innerHTML = this.books.map(book => this.renderBookCard(book)).join('');

        booksGrid.querySelectorAll('.book-card').forEach(card => {
            const bookId = card.dataset.bookId;
            card.querySelector('.read-btn').addEventListener('click', (e) => { e.stopPropagation(); this.openBook(bookId); });
            card.querySelector('.download-btn').addEventListener('click', (e) => { e.stopPropagation(); this.downloadBook(bookId); });
            card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); this.deleteBook(bookId); });
        });
    }

    renderBookCard(book) {
        const formatIcons = { 'TXT': '📄', 'PDF': '📕', 'EPUB': '📘', 'MOBI': '📙' };
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
                    <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
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

    async openBook(bookId) {
        try {
            const response = await this.apiFetch(`/api/books/${bookId}`);
            const data = await response.json();

            if (!response.ok) {
                this.showToast(data.error || '打开书籍失败');
                return;
            }

            const book = data.book;

            if (book.format.toLowerCase() === 'txt' && data.content) {
                this.displayBookContent(book, data.content);
                document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
                document.querySelector('[data-view="reader"]').classList.add('active');
                document.getElementById('readerView').classList.add('active');
                document.getElementById('libraryView').classList.remove('active');
                document.getElementById('historyView').classList.remove('active');
                document.getElementById('settingsView').classList.remove('active');
            } else {
                this.showToast('该格式书籍暂不支持在线阅读，请下载后使用专业阅读器打开');
            }
        } catch (error) {
            console.error('打开书籍失败:', error);
            this.showToast('打开书籍失败');
        }
    }

    displayBookContent(book, content) {
        this.uploadedFileName = book.originalName || book.original_name;

        document.getElementById('articleTitle').textContent = book.title;

        const wordCount = content.length;
        const readingTime = Math.max(1, Math.ceil(wordCount / 500));
        document.getElementById('articleMeta').innerHTML = `
            <span class="meta-item">文件名：${this.escapeHtml(this.uploadedFileName)}</span>
            <span class="meta-item">字数：约${wordCount}字</span>
            <span class="meta-item">阅读时间：约${readingTime}分钟</span>
        `;

        document.getElementById('articleContent').innerHTML = this.formatTextContent(content);
        document.getElementById('fileName').textContent = this.uploadedFileName;
        document.getElementById('fileInfo').style.display = 'flex';
        document.getElementById('uploadArea').style.display = 'none';

        this.updateTableOfContents();
        this.showToast(`正在阅读: ${book.title}`);
    }

    downloadBook(bookId) {
        const link = document.createElement('a');
        link.href = `/api/books/${bookId}/download`;
        link.setAttribute('download', '');
        this.apiFetch(`/api/books/${bookId}/download`).then(res => {
            if (!res.ok) throw new Error('下载失败');
            return res.blob();
        }).then(blob => {
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);
        }).catch(err => {
            this.showToast('下载失败');
        });
    }

    async deleteBook(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) return;
        if (!confirm(`确定要删除《${book.title}》吗？\n删除后文件将无法恢复。`)) return;

        try {
            const response = await this.apiFetch(`/api/books/${bookId}`, { method: 'DELETE' });
            const data = await response.json();

            if (data.success) {
                this.showToast('书籍已删除');
                this.books = this.books.filter(b => b.id !== bookId);
                this.renderBooks();
            } else {
                this.showToast(data.error || '删除失败');
            }
        } catch (error) {
            console.error('删除书籍失败:', error);
            this.showToast('删除失败，请检查网络连接');
        }
    }

    initFileUploadListeners() {
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const uploadBtn = document.getElementById('uploadBtn');
        const removeFileBtn = document.getElementById('removeFileBtn');

        uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        uploadArea.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this.handleFileUpload(e.target.files[0]);
        });

        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
        uploadArea.addEventListener('dragleave', (e) => { e.preventDefault(); uploadArea.classList.remove('drag-over'); });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0) this.handleFileUpload(files[0]);
        });

        removeFileBtn.addEventListener('click', () => this.removeUploadedFile());
    }

    handleFileUpload(file) {
        if (!file.name.toLowerCase().endsWith('.txt')) {
            this.showToast('请上传 .txt 格式的文件');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => this.displayUploadedContent(file.name, e.target.result);
        reader.onerror = () => this.showToast('文件读取失败，请重试');
        reader.readAsText(file, 'UTF-8');
    }

    displayUploadedContent(fileName, content) {
        this.uploadedFileName = fileName;
        const titleWithoutExt = fileName.replace(/\.txt$/i, '');
        document.getElementById('articleTitle').textContent = titleWithoutExt;

        const wordCount = content.length;
        const readingTime = Math.max(1, Math.ceil(wordCount / 500));
        document.getElementById('articleMeta').innerHTML = `
            <span class="meta-item">文件名：${this.escapeHtml(fileName)}</span>
            <span class="meta-item">字数：约${wordCount}字</span>
            <span class="meta-item">阅读时间：约${readingTime}分钟</span>
        `;

        document.getElementById('articleContent').innerHTML = this.formatTextContent(content);
        document.getElementById('fileName').textContent = fileName;
        document.getElementById('fileInfo').style.display = 'flex';
        document.getElementById('uploadArea').style.display = 'none';

        this.updateTableOfContents();
        this.showToast('文件上传成功！');
    }

    formatTextContent(content) {
        const paragraphs = content.split(/\n+/).filter(p => p.trim());
        let html = '';
        let sectionCount = 0;
        let inSection = false;

        paragraphs.forEach(para => {
            para = para.trim();
            if (!para) return;
            const headingMatch = para.match(/^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i);
            if (headingMatch) {
                if (inSection) html += '</section>';
                sectionCount++;
                html += `<section id="section${sectionCount}" class="content-section">`;
                html += `<h2>${this.escapeHtml(para)}</h2>`;
                inSection = true;
            } else if (para.length < 50 && !/[。，！？；：]/.test(para)) {
                html += `<h3>${this.escapeHtml(para)}</h3>`;
            } else {
                html += `<p>${this.escapeHtml(para)}</p>`;
            }
        });

        if (inSection) html += '</section>';

        if (sectionCount === 0) {
            html = '<section id="section1" class="content-section">';
            paragraphs.forEach(para => {
                para = para.trim();
                if (!para) return;
                html += `<p>${this.escapeHtml(para)}</p>`;
            });
            html += '</section>';
        }
        return html;
    }

    updateTableOfContents() {
        const tocList = document.getElementById('tocList');
        const sections = document.querySelectorAll('.content-section');

        if (sections.length === 0) {
            tocList.innerHTML = '<li class="toc-item active" data-section="section1">全文</li>';
            return;
        }

        let tocHtml = '';
        sections.forEach((section, index) => {
            const heading = section.querySelector('h2');
            const title = heading ? heading.textContent : `第${index + 1}节`;
            tocHtml += `<li class="toc-item ${index === 0 ? 'active' : ''}" data-section="${section.id}">${this.escapeHtml(title)}</li>`;
        });
        tocList.innerHTML = tocHtml;

        document.querySelectorAll('.toc-item').forEach(item => {
            item.addEventListener('click', (e) => this.scrollToSection(e));
        });
    }

    removeUploadedFile() {
        if (!this.uploadedFileName) return;
        this.uploadedFileName = null;
        document.getElementById('fileInput').value = '';
        document.getElementById('fileInfo').style.display = 'none';
        document.getElementById('uploadArea').style.display = 'flex';

        if (this.originalContent) {
            document.getElementById('articleTitle').textContent = this.originalContent.title;
            document.getElementById('articleMeta').innerHTML = this.originalContent.meta;
            document.getElementById('articleContent').innerHTML = this.originalContent.content;
        }
        this.restoreOriginalToc();
        this.showToast('已移除上传的文件');
    }

    restoreOriginalToc() {
        const tocList = document.getElementById('tocList');
        tocList.innerHTML = `
            <li class="toc-item active" data-section="section1">第一章</li>
            <li class="toc-item" data-section="section2">第二章</li>
            <li class="toc-item" data-section="section3">第三章</li>
            <li class="toc-item" data-section="section4">第四章</li>
            <li class="toc-item" data-section="section5">第五章</li>
        `;
        document.querySelectorAll('.toc-item').forEach(item => {
            item.addEventListener('click', (e) => this.scrollToSection(e));
        });
    }

    initApiKeyListeners() {
        document.getElementById('configureApiBtn').addEventListener('click', () => this.switchToSettings());
        document.getElementById('toggleVisibilityBtn').addEventListener('click', () => this.toggleKeyVisibility('apiKeyInput'));
        document.getElementById('saveApiKeyBtn').addEventListener('click', () => this.saveApiKey());
        document.getElementById('verifyApiKeyBtn').addEventListener('click', () => this.verifyApiKey());
        document.getElementById('deleteApiKeyBtn').addEventListener('click', () => this.deleteApiKey());
        document.getElementById('closeModalBtn').addEventListener('click', () => this.hideModal());
        document.getElementById('modalCancelBtn').addEventListener('click', () => this.hideModal());
        document.getElementById('modalSaveBtn').addEventListener('click', () => this.saveApiKeyFromModal());

        const addModelBtn = document.getElementById('addModelBtn');
        if (addModelBtn) addModelBtn.addEventListener('click', () => this.addCustomModel());
        const customModelIdInput = document.getElementById('customModelId');
        if (customModelIdInput) customModelIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.addCustomModel(); } });

        this.apiKeyModal.addEventListener('click', (e) => {
            if (e.target === this.apiKeyModal) this.hideModal();
        });

        document.getElementById('apiKeyInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.saveApiKey();
        });

        document.getElementById('modalApiKeyInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.saveApiKeyFromModal();
        });
    }

    async checkApiKeyStatus() {
        const statusIndicator = document.querySelector('.status-indicator');
        const statusText = document.querySelector('.status-text');
        const keyStatusValue = document.getElementById('keyStatusValue');

        statusIndicator.className = 'status-indicator checking';
        statusText.textContent = '检查中...';
        if (keyStatusValue) { keyStatusValue.textContent = '检查中...'; keyStatusValue.className = 'status-value'; }

        try {
            const response = await this.apiFetch('/api/key/status');
            const data = await response.json();

            this.apiProviders = data.providers || {};
            const providerData = this.apiProviders[this.currentProvider] || {};
            const hasKey = providerData.hasKey;

            if (hasKey) {
                statusIndicator.className = 'status-indicator active';
                statusText.textContent = '已配置';
                if (keyStatusValue) { keyStatusValue.textContent = '已配置'; keyStatusValue.className = 'status-value connected'; }
                document.getElementById('maskedKeyRow').style.display = 'flex';
                document.getElementById('maskedKeyValue').textContent = providerData.maskedKey;
                if (providerData.lastUpdated) {
                    document.getElementById('lastUpdatedRow').style.display = 'flex';
                    document.getElementById('lastUpdatedValue').textContent = new Date(providerData.lastUpdated).toLocaleString('zh-CN');
                }
                document.getElementById('deleteApiKeyBtn').style.display = 'inline-flex';
                const providerInfo = this.providers.find(p => p.id === this.currentProvider);
                if (providerInfo) {
                    document.getElementById('modelRow').style.display = 'flex';
                    document.getElementById('modelValue').textContent = this.currentModel || providerInfo.defaultModel;
                }
            } else {
                statusIndicator.className = 'status-indicator inactive';
                statusText.textContent = '未配置';
                if (keyStatusValue) { keyStatusValue.textContent = '未配置'; keyStatusValue.className = 'status-value disconnected'; }
                document.getElementById('maskedKeyRow').style.display = 'none';
                document.getElementById('lastUpdatedRow').style.display = 'none';
                document.getElementById('deleteApiKeyBtn').style.display = 'none';
                document.getElementById('modelRow').style.display = 'none';
            }
        } catch (error) {
            console.error('检查API状态失败:', error);
            statusIndicator.className = 'status-indicator inactive';
            statusText.textContent = '检查失败';
            if (keyStatusValue) { keyStatusValue.textContent = '检查失败'; keyStatusValue.className = 'status-value disconnected'; }
        }
    }

    updateSettingsView(data) {
        const keyStatusValue = document.getElementById('keyStatusValue');
        if (data.hasKey) {
            keyStatusValue.textContent = '已配置';
            keyStatusValue.className = 'status-value connected';
            document.getElementById('maskedKeyValue').textContent = data.maskedKey;
            document.getElementById('maskedKeyRow').style.display = 'flex';
            if (data.lastUpdated) {
                document.getElementById('lastUpdatedValue').textContent = new Date(data.lastUpdated).toLocaleString('zh-CN');
                document.getElementById('lastUpdatedRow').style.display = 'flex';
            }
            document.getElementById('deleteApiKeyBtn').style.display = 'inline-flex';
        } else {
            keyStatusValue.textContent = '未配置';
            keyStatusValue.className = 'status-value disconnected';
            document.getElementById('maskedKeyRow').style.display = 'none';
            document.getElementById('lastUpdatedRow').style.display = 'none';
            document.getElementById('deleteApiKeyBtn').style.display = 'none';
        }
    }

    toggleKeyVisibility(inputId) {
        const input = document.getElementById(inputId);
        input.type = input.type === 'password' ? 'text' : 'password';
    }

    async saveApiKey() {
        const input = document.getElementById('apiKeyInput');
        const apiKey = input.value.trim();
        if (!apiKey) { this.showToast('请输入API密钥'); return; }

        const btn = document.getElementById('saveApiKeyBtn');
        btn.classList.add('loading');
        btn.disabled = true;

        try {
            const response = await this.apiFetch('/api/key/set', {
                method: 'POST',
                body: JSON.stringify({ apiKey, provider: this.currentProvider })
            });
            const data = await response.json();
            if (response.ok) {
                this.showToast('API密钥保存成功！');
                input.value = '';
                this.checkApiKeyStatus();
            } else {
                this.showToast(data.error || '保存失败');
            }
        } catch (error) {
            console.error('保存API密钥失败:', error);
            this.showToast('保存失败，请检查网络连接');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    async verifyApiKey() {
        const btn = document.getElementById('verifyApiKeyBtn');
        btn.classList.add('loading');
        btn.disabled = true;

        try {
            const response = await this.apiFetch('/api/key/verify', {
                method: 'POST',
                body: JSON.stringify({ provider: this.currentProvider })
            });
            const data = await response.json();
            if (data.valid) {
                this.showToast('API密钥验证成功！');
            } else {
                this.showToast(data.error || 'API密钥无效');
            }
        } catch (error) {
            console.error('验证API密钥失败:', error);
            this.showToast('验证失败，请检查网络连接');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    async deleteApiKey() {
        const providerInfo = this.providers.find(p => p.id === this.currentProvider);
        const name = providerInfo ? providerInfo.name : '';
        if (!confirm(`确定要删除已保存的${name}API密钥吗？删除后将无法使用AI功能。`)) return;

        try {
            const response = await this.apiFetch('/api/key', {
                method: 'DELETE',
                body: JSON.stringify({ provider: this.currentProvider })
            });
            const data = await response.json();
            if (data.success) {
                this.showToast('API密钥已删除');
                this.checkApiKeyStatus();
            } else {
                this.showToast(data.error || '删除失败');
            }
        } catch (error) {
            console.error('删除API密钥失败:', error);
            this.showToast('删除失败，请检查网络连接');
        }
    }

    async saveApiKeyFromModal() {
        const input = document.getElementById('modalApiKeyInput');
        const apiKey = input.value.trim();
        if (!apiKey) { this.showToast('请输入API密钥'); return; }

        const btn = document.getElementById('modalSaveBtn');
        btn.classList.add('loading');
        btn.disabled = true;

        try {
            const response = await this.apiFetch('/api/key/set', {
                method: 'POST',
                body: JSON.stringify({ apiKey, provider: this.currentProvider })
            });
            const data = await response.json();
            if (response.ok) {
                this.showToast('API密钥配置成功！');
                this.hideModal();
                this.checkApiKeyStatus();
            } else {
                this.showToast(data.error || '配置失败');
            }
        } catch (error) {
            console.error('保存API密钥失败:', error);
            this.showToast('配置失败，请检查网络连接');
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    showModal() {
        this.apiKeyModal.classList.add('visible');
        document.getElementById('modalApiKeyInput').focus();
    }

    hideModal() {
        this.apiKeyModal.classList.remove('visible');
        document.getElementById('modalApiKeyInput').value = '';
    }

    switchToSettings() {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-view="settings"]').classList.add('active');
        document.getElementById('readerView').classList.remove('active');
        document.getElementById('historyView').classList.remove('active');
        document.getElementById('libraryView').classList.remove('active');
        document.getElementById('settingsView').classList.add('active');
    }

    handleTextSelection(e) {
        if (this.floatingToolbar.contains(e.target) || this.aiPanel.contains(e.target)) return;
        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            if (text.length > 0) {
                this.selectedText = text;
                this.showFloatingToolbar(selection);
            } else {
                this.hideFloatingToolbar();
            }
        }, 10);
    }

    handleMouseDown(e) {
        if (!this.floatingToolbar.contains(e.target) && !this.aiPanel.contains(e.target)) {
            this.hideFloatingToolbar();
        }
    }

    showFloatingToolbar(selection) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this.floatingToolbar.style.visibility = 'hidden';
        this.floatingToolbar.style.display = 'flex';

        const toolbarWidth = this.floatingToolbar.offsetWidth || 280;
        const toolbarHeight = this.floatingToolbar.offsetHeight || 45;

        let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
        let top = rect.top - toolbarHeight - 10;
        if (top < 10) top = rect.bottom + 10;
        left = Math.max(10, Math.min(left, window.innerWidth - toolbarWidth - 10));

        this.floatingToolbar.style.left = `${left}px`;
        this.floatingToolbar.style.top = `${top}px`;
        this.floatingToolbar.style.visibility = 'visible';
        this.floatingToolbar.classList.add('visible');
    }

    hideFloatingToolbar() {
        this.floatingToolbar.classList.remove('visible');
        this.floatingToolbar.style.display = '';
        this.floatingToolbar.style.visibility = '';
    }

    handleToolbarAction(e) {
        const action = e.currentTarget.dataset.action;
        if (action === 'ask') {
            this.openAIPanel();
        } else {
            this.executeAction(action);
        }
        this.hideFloatingToolbar();
    }

    isProviderConfigured() {
        const providerData = this.apiProviders[this.currentProvider];
        return providerData && providerData.hasKey;
    }

    handleQuickAction(e) {
        this.executeAction(e.currentTarget.dataset.action);
    }

    async executeAction(action) {
        if (!this.selectedText) { this.showToast('请先选中要提问的文本'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }

        const actionMap = {
            'explain': '请解释这段文字的含义',
            'summarize': '请总结这段文字的要点',
            'translate': '请将这段文字翻译成英文',
            'expand': '请提供与这段文字相关的扩展知识'
        };

        const question = actionMap[action] || action;
        this.openAIPanel();
        await this.askAI(question);
    }

    openAIPanel() {
        this.selectedTextContent.textContent = this.selectedText;
        this.aiPanel.classList.add('open');
        this.questionInput.focus();
        this.responseContent.innerHTML = '<p class="placeholder-text">选中文字后，点击快捷操作或输入问题，AI将为您提供解答。</p>';
    }

    closeAIPanel() {
        this.aiPanel.classList.remove('open');
    }

    async handleAskQuestion() {
        const question = this.questionInput.value.trim();
        if (!question) { this.showToast('请输入您的问题'); return; }
        if (!this.selectedText) { this.showToast('请先选中要提问的文本'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        await this.askAI(question);
    }

    async askAI(question) {
        this.askBtn.classList.add('loading');
        this.askBtn.disabled = true;
        this.responseContent.innerHTML = '<p class="placeholder-text">🤔 AI正在思考中...</p>';

        try {
            const response = await this.apiFetch('/api/ask-stream', {
                method: 'POST',
                body: JSON.stringify({
                    text: this.selectedText,
                    question: question,
                    bookName: this.getCurrentBookName(),
                    provider: this.currentProvider,
                    model: this.currentModel
                })
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.needApiKey) {
                    const providerInfo = this.providers.find(p => p.id === (data.provider || this.currentProvider));
                    const name = providerInfo ? providerInfo.name : 'AI';
                    this.responseContent.innerHTML = `
                        <div class="api-warning">
                            <span class="api-warning-icon">⚠️</span>
                            <div class="api-warning-text">
                                <strong>需要配置API密钥</strong>
                                请先配置${name}的API密钥以使用AI功能
                            </div>
                        </div>
                    `;
                    this.checkApiKeyStatus();
                } else {
                    this.responseContent.innerHTML = `<p style="color: #ef4444;">错误: ${this.escapeHtml(data.error)}</p>`;
                }
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullContent = '';

            this.responseContent.innerHTML = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (!dataStr.trim()) continue;
                        try {
                            const parsed = JSON.parse(dataStr);
                            if (parsed.type === 'start') {
                                const responseHeader = document.querySelector('.response-header');
                                if (responseHeader) {
                                    responseHeader.innerHTML = `
                                        <span class="response-label">AI回答：</span>
                                        <span class="model-tag-inline">🤖 ${parsed.provider} · ${parsed.model}</span>
                                    `;
                                }
                                this.responseContent.innerHTML = '<div class="answer-content"></div>';
                            } else if (parsed.type === 'chunk') {
                                fullContent += parsed.content;
                                const contentEl = this.responseContent.querySelector('.answer-content');
                                if (contentEl) {
                                    contentEl.innerHTML = this.escapeHtml(fullContent).replace(/\n/g, '<br>');
                                    contentEl.scrollTop = contentEl.scrollHeight;
                                }
                            } else if (parsed.type === 'end') {
                                this.saveToHistory(this.selectedText, question, fullContent);
                            } else if (parsed.type === 'error') {
                                this.responseContent.innerHTML = `<p style="color: #ef4444;">错误: ${this.escapeHtml(parsed.error)}</p>`;
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (error) {
            console.error('请求失败:', error);
            this.responseContent.innerHTML = '<p style="color: #ef4444;">网络错误，请检查服务器是否正常运行</p>';
        } finally {
            this.askBtn.classList.remove('loading');
            this.askBtn.disabled = false;
            this.questionInput.value = '';
        }
    }

    switchView(e) {
        const view = e.currentTarget.dataset.view;
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        e.currentTarget.classList.add('active');

        document.getElementById('readerView').classList.toggle('active', view === 'reader');
        document.getElementById('historyView').classList.toggle('active', view === 'history');
        document.getElementById('settingsView').classList.toggle('active', view === 'settings');
        document.getElementById('libraryView').classList.toggle('active', view === 'library');

        if (view === 'settings') this.checkApiKeyStatus();
        if (view === 'library') this.loadBooks();
    }

    scrollToSection(e) {
        const section = document.getElementById(e.currentTarget.dataset.section);
        if (section) {
            section.scrollIntoView({ behavior: 'smooth' });
            document.querySelectorAll('.toc-item').forEach(item => item.classList.remove('active'));
            e.currentTarget.classList.add('active');
        }
    }

    changeFontSize(delta) {
        this.currentFontSize = Math.max(12, Math.min(28, this.currentFontSize + delta));
        this.articleContent.style.fontSize = `${this.currentFontSize}px`;
        document.getElementById('fontSizeDisplay').textContent = `${this.currentFontSize}px`;
    }

    changeTheme(e) {
        const theme = e.currentTarget.dataset.theme;
        this.currentTheme = theme;
        document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
        e.currentTarget.classList.add('active');
        document.documentElement.setAttribute('data-theme', theme);
    }

    handleKeyboardShortcuts(e) {
        if (e.ctrlKey && e.key === 'Enter') {
            if (this.aiPanel.classList.contains('open')) this.handleAskQuestion();
        }
        if (e.key === 'Escape') {
            this.closeAIPanel();
            this.hideFloatingToolbar();
            this.hideModal();
        }
    }

    // ==================== Server-side History ====================

    async saveToHistory(selectedText, question, answer) {
        const item = {
            id: Date.now(),
            text: selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : ''),
            question: question,
            answer: answer,
            time: new Date().toLocaleString('zh-CN')
        };

        this.history.unshift(item);
        if (this.history.length > 50) this.history = this.history.slice(0, 50);
        this.renderHistory();

        try {
            await this.apiFetch('/api/history', {
                method: 'POST',
                body: JSON.stringify({ text: selectedText, question, answer })
            });
        } catch (e) {
            console.error('保存历史失败', e);
        }
    }

    async loadHistory() {
        try {
            const res = await this.apiFetch('/api/history');
            const data = await res.json();
            this.history = (data.history || []).map(h => ({
                id: h.id,
                text: h.text,
                question: h.question,
                answer: h.answer,
                time: h.time
            }));
        } catch {
            this.history = [];
        }
        this.renderHistory();
    }

    renderHistory() {
        if (this.history.length === 0) {
            this.historyList.innerHTML = '<p class="empty-history">暂无历史记录</p>';
            return;
        }

        this.historyList.innerHTML = this.history.map(item => `
            <div class="history-item">
                <div class="history-selected-text">${this.escapeHtml(item.text)}</div>
                <div class="history-question">❓ ${this.escapeHtml(item.question)}</div>
                <div class="history-answer">${this.escapeHtml(item.answer)}</div>
                <div class="history-time">${item.time}</div>
            </div>
        `).join('');
    }

    async clearHistory() {
        if (confirm('确定要清空所有历史记录吗？')) {
            this.history = [];
            this.renderHistory();
            try {
                await this.apiFetch('/api/history', { method: 'DELETE' });
            } catch (e) {
                console.error('清空历史失败', e);
            }
            this.showToast('历史记录已清空');
        }
    }

    showToast(message) {
        this.toast.textContent = message;
        this.toast.classList.add('show');
        setTimeout(() => this.toast.classList.remove('show'), 3000);
    }

    getCurrentBookName() {
        if (this.uploadedFileName) return this.uploadedFileName.replace(/\.[^.]+$/, '');
        const titleEl = document.getElementById('articleTitle');
        if (titleEl && titleEl.textContent) return titleEl.textContent.trim();
        return null;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new AIReadingAssistant();
});
