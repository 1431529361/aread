class AIReadingAssistant {
    constructor() {
        this.selectedText = '';
        this.history = [];
        this.currentFontSize = parseInt(localStorage.getItem('fontSize')) || 18;
        this.currentTheme = localStorage.getItem('theme') || 'light';
        this.apiProviders = {};
        this.currentProvider = localStorage.getItem('selectedProvider') || 'zhipu';
        this.currentModel = localStorage.getItem(`selectedModel_${this.currentProvider}`) || null;
        this.books = [];
        this.providers = [];
        this.currentBook = null;
        this.currentBookContent = null;
        this.isReading = false;
        this.agentMode = false;
        this.toolbarsVisible = false;
        this.currentConversationId = null;
        this.currentContextTokens = 0;
        this.currentContextLimit = 0;
        this._chatLoadedConvId = null;
        this._openingConv = false;

        this.token = localStorage.getItem('authToken') || null;
        this.currentUser = null;
        this.isAuthenticated = false;
        this.authMode = 'login';

        // Apply saved theme
        if (this.currentTheme !== 'light') {
            document.documentElement.setAttribute('data-theme', this.currentTheme);
        }

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
                document.getElementById('authSubmitBtn').querySelector('.btn-text').textContent = this.authMode === 'login' ? '登录' : '注册';
                document.getElementById('authError').textContent = '';
            });
        });
        document.getElementById('authForm').addEventListener('submit', (e) => { e.preventDefault(); this.handleAuthSubmit(); });
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
        const myLogoutBtn = document.getElementById('myLogoutBtn');
        if (myLogoutBtn) myLogoutBtn.addEventListener('click', () => this.logout());
    }

    async handleAuthSubmit() {
        const username = document.getElementById('authUsername').value.trim();
        const password = document.getElementById('authPassword').value;
        const rememberMe = document.getElementById('rememberMe').checked;
        const errorEl = document.getElementById('authError');
        const submitBtn = document.getElementById('authSubmitBtn');

        if (!username) { errorEl.textContent = '请输入用户名'; return; }
        if (!password || password.length < 6) { errorEl.textContent = '密码至少6位'; return; }

        errorEl.textContent = '';
        submitBtn.classList.add('loading');
        submitBtn.disabled = true;

        try {
            const endpoint = this.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const body = this.authMode === 'login' ? { username, password, rememberMe } : { username, password };
            const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
        } catch {
            errorEl.textContent = '网络错误，请检查服务器连接';
        } finally {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
        }
    }

    async validateToken() {
        try {
            const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${this.token}` } });
            if (res.ok) {
                const data = await res.json();
                this.currentUser = data.user;
                this.isAuthenticated = true;
                this.hideAuthScreen();
                this.initApp();
            } else { this.logout(); }
        } catch { this.showAuthScreen(); }
    }

    showAuthScreen() { document.getElementById('authOverlay').classList.add('visible'); }
    hideAuthScreen() { document.getElementById('authOverlay').classList.remove('visible'); }

    logout() {
        this.token = null;
        this.currentUser = null;
        this.isAuthenticated = false;
        localStorage.removeItem('authToken');
        const userInfo = document.getElementById('userInfo');
        if (userInfo) userInfo.style.display = 'none';
        document.getElementById('authUsername').value = '';
        document.getElementById('authPassword').value = '';
        document.getElementById('authError').textContent = '';
        this.showAuthScreen();
    }

    initApp() {
        if (this.currentUser) {
            document.getElementById('displayUsername').textContent = this.currentUser.username;
            document.getElementById('userInfo').style.display = 'flex';
            const myUsername = document.getElementById('myUsername');
            if (myUsername) myUsername.textContent = this.currentUser.username;
            const myAvatar = document.getElementById('myAvatar');
            if (myAvatar) myAvatar.textContent = this.currentUser.username.charAt(0).toUpperCase();
        }
        this.initEventListeners();
        this.loadProviders();
        this.checkApiKeyStatus();
        this.loadHistory();
        this.loadBooks();
        // Apply saved font size
        document.getElementById('fontSizeDisplay').textContent = `${this.currentFontSize}px`;
        document.getElementById('readFontSizeDisplay').textContent = `${this.currentFontSize}px`;
    }

    // ==================== API Fetch Wrapper ====================

    async apiFetch(url, options = {}) {
        if (!options.headers) options.headers = {};
        options.headers['Authorization'] = `Bearer ${this.token}`;
        if (options.body && !(options.body instanceof FormData) && !options._skipContentType) {
            options.headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, options);
        if (response.status === 401) { this.logout(); throw new Error('登录已过期'); }
        return response;
    }

    // ==================== Elements ====================

    initElements() {
        this.floatingToolbar = document.getElementById('floatingToolbar');
        this.selectedTextContent = document.getElementById('selectedTextContent');
        this.questionInput = document.getElementById('questionInput');
        this.askBtn = document.getElementById('askBtn');
        this.chatMessages = document.getElementById('chatMessages');
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
        this.agentTaskModal = document.getElementById('agentTaskModal');
    }

    // ==================== Event Listeners ====================

    initEventListeners() {
        // Bottom navigation
        document.querySelectorAll('.bottom-nav-item').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e.currentTarget.dataset.view));
        });

        // History clear button (removed in conversation-history redesign; guarded)
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', () => this.clearHistory());

        // Text selection (in reading view)
        document.addEventListener('mouseup', (e) => this.handleTextSelection(e));
        document.addEventListener('mousedown', (e) => this.handleMouseDown(e));

        // Floating toolbar
        this.floatingToolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.toolbar-btn');
            if (btn) this.handleToolbarAction({ currentTarget: btn });
        });

        // AI chat quick actions (delegated)
        document.getElementById('aiChatView').addEventListener('click', (e) => {
            const btn = e.target.closest('.quick-action-btn');
            if (btn) this.handleQuickAction({ currentTarget: btn });
        });

        this.askBtn.addEventListener('click', () => this.handleAskQuestion());
        this.questionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleAskQuestion(); }
        });
        this.questionInput.addEventListener('input', () => this.autoGrowInput());
        document.getElementById('chatBackBtn').addEventListener('click', () => this.closeAIPanel());
        const clearCtxBtn = document.getElementById('clearSelectedTextBtn');
        if (clearCtxBtn) clearCtxBtn.addEventListener('click', () => this.clearComposerContext());

        // Agent mode toggle
        const agentToggle = document.getElementById('agentModeToggle');
        if (agentToggle) agentToggle.addEventListener('change', (e) => {
            this.agentMode = e.target.checked;
        });

        // Session controls
        const newConvBtn = document.getElementById('newConversationBtn');
        if (newConvBtn) newConvBtn.addEventListener('click', () => this.newConversation());
        const compressBtn = document.getElementById('compressBtn');
        if (compressBtn) compressBtn.addEventListener('click', () => this.compressContext());
        const memoryBtn = document.getElementById('memoryBtn');
        if (memoryBtn) memoryBtn.addEventListener('click', () => this.openMemoryModal());
        const memoryClose = document.getElementById('memoryModalClose');
        if (memoryClose) memoryClose.addEventListener('click', () => this.closeMemoryModal());
        const memoryMask = document.getElementById('memoryModalMask');
        if (memoryMask) memoryMask.addEventListener('click', () => this.closeMemoryModal());
        const memoryClearAll = document.getElementById('memoryClearAllBtn');
        if (memoryClearAll) memoryClearAll.addEventListener('click', () => this.clearAllMemories());

        // Agent task modal
        const taskCloseBtn = document.getElementById('agentTaskCloseBtn');
        const taskCancelBtn = document.getElementById('agentTaskCancelBtn');
        if (taskCloseBtn) taskCloseBtn.addEventListener('click', () => this.closeTaskModal());
        if (taskCancelBtn) taskCancelBtn.addEventListener('click', () => this.closeTaskModal());

        // Reading view controls
        document.getElementById('exitReadingBtn').addEventListener('click', () => this.exitReading());
        document.getElementById('tocBtn').addEventListener('click', () => this.openTocDrawer());
        document.getElementById('tocCloseBtn').addEventListener('click', () => this.closeTocDrawer());
        document.getElementById('tocOverlay').addEventListener('click', () => this.closeTocDrawer());

        document.getElementById('readingFontBtn').addEventListener('click', () => this.toggleReadingSettings());
        document.getElementById('readingThemeBtn').addEventListener('click', () => this.toggleReadingSettings());

        // Font size in reading panel
        document.getElementById('readDecreaseFont').addEventListener('click', () => this.changeFontSize(-2));
        document.getElementById('readIncreaseFont').addEventListener('click', () => this.changeFontSize(2));
        document.getElementById('decreaseFont').addEventListener('click', () => this.changeFontSize(-2));
        document.getElementById('increaseFont').addEventListener('click', () => this.changeFontSize(2));

        // Theme buttons (everywhere)
        document.querySelectorAll('.theme-btn, .theme-card').forEach(btn => {
            btn.addEventListener('click', (e) => this.changeTheme(e.currentTarget.dataset.theme));
        });

        // AI toggle
        document.getElementById('aiToggleBtn').addEventListener('click', () => this.toggleAIPanel());
        document.getElementById('aiFab').addEventListener('click', () => this.toggleAIPanel());

        // Reading content click to toggle toolbars
        document.getElementById('readingContent').addEventListener('click', (e) => {
            if (e.target.closest('.reading-toolbar') || e.target.closest('.ai-chat-view') || e.target.closest('.toc-drawer')) return;
            this.toggleToolbars();
        });

        // Reading scroll progress
        document.getElementById('readingContent').addEventListener('scroll', () => this.updateReadingProgress());

        // Library listeners
        this.initLibraryListeners();

        // API key listeners
        this.initApiKeyListeners();

        // Custom provider listeners
        this.initCustomProviderListeners();

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
    }

    // ==================== View Switching ====================

    switchView(view) {
        document.getElementById('bookshelfView').classList.toggle('active', view === 'bookshelf');
        document.getElementById('historyView').classList.toggle('active', view === 'history');
        document.getElementById('settingsView').classList.toggle('active', view === 'settings');

        document.querySelectorAll('.bottom-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        if (view === 'settings') {
            this.checkApiKeyStatus();
            this.updateMyPage();
            this.loadEmbeddingSettings();
        }
        if (view === 'bookshelf') this.loadBooks();
        if (view === 'history') this.loadHistory();
    }

    updateMyPage() {
        if (this.currentUser) {
            const myUsername = document.getElementById('myUsername');
            if (myUsername) myUsername.textContent = this.currentUser.username;
            const myAvatar = document.getElementById('myAvatar');
            if (myAvatar) myAvatar.textContent = this.currentUser.username.charAt(0).toUpperCase();
        }
    }

    // ==================== Library / Bookshelf ====================

    initLibraryListeners() {
        const uploadCard = document.getElementById('uploadCard');
        const bookFileInput = document.getElementById('bookFileInput');
        const uploadBookBtn = document.getElementById('uploadBookBtn');

        uploadCard.addEventListener('click', (e) => { if (e.target !== uploadBookBtn) bookFileInput.click(); });
        uploadBookBtn.addEventListener('click', (e) => { e.stopPropagation(); bookFileInput.click(); });
        bookFileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) this.uploadBook(e.target.files[0]); });

        uploadCard.addEventListener('dragover', (e) => { e.preventDefault(); uploadCard.style.borderColor = 'var(--primary)'; });
        uploadCard.addEventListener('dragleave', (e) => { e.preventDefault(); uploadCard.style.borderColor = ''; });
        uploadCard.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadCard.style.borderColor = '';
            if (e.dataTransfer.files.length > 0) this.uploadBook(e.dataTransfer.files[0]);
        });
    }

    async loadBooks() {
        try {
            const response = await this.apiFetch('/api/books');
            const data = await response.json();
            this.books = data.books || [];
            this.renderBooks();
        } catch (error) { console.error('加载书籍列表失败:', error); }
    }

    async uploadBook(file) {
        const allowedExts = ['.txt', '.pdf', '.epub', '.mobi'];
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (!allowedExts.includes(ext)) { this.showToast(`不支持的格式。支持: ${allowedExts.join(', ')}`); return; }
        if (file.size > 50 * 1024 * 1024) { this.showToast('文件超过50MB限制'); return; }

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
                } else if (xhr.status === 401) { this.logout(); }
                else { this.showToast(JSON.parse(xhr.responseText).error || '上传失败'); }
            });
            xhr.addEventListener('error', () => { uploadProgress.style.display = 'none'; this.showToast('上传失败'); });
            xhr.open('POST', '/api/books/upload');
            xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
            xhr.send(formData);
        } catch { uploadProgress.style.display = 'none'; this.showToast('上传失败'); }
    }

    renderBooks() {
        const booksGrid = document.getElementById('booksGrid');
        const libraryStats = document.getElementById('libraryStats');
        libraryStats.innerHTML = `<span>共 <strong>${this.books.length}</strong> 本书</span>`;

        if (this.books.length === 0) {
            booksGrid.innerHTML = `<div class="empty-library"><svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><p>书架空空如也</p><p class="empty-hint">上传你的第一本书开始阅读吧</p></div>`;
            return;
        }

        const colors = ['#4f46e5','#7c3aed','#2563eb','#0891b2','#059669','#d97706','#dc2626','#be185d'];
        booksGrid.innerHTML = this.books.map((book, i) => {
            const progress = book.readProgress || book.read_progress || 0;
            const color = colors[i % colors.length];
            return `
                <div class="book-card" data-book-id="${book.id}">
                    <div class="book-cover" style="background:linear-gradient(135deg,${color},${color}dd)">
                        <svg class="book-cover-icon" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                        <span class="book-format-badge">${book.format}</span>
                    </div>
                    <div class="book-info">
                        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
                        <div class="book-progress">${progress > 0 ? `已读 ${Math.round(progress * 100)}%` : '未读'}</div>
                    </div>
                    <div class="book-actions-row">
                        <button class="book-action-btn read-btn">阅读</button>
                        ${book.format.toLowerCase() === 'txt' ? '<button class="book-action-btn index-btn">AI索引</button><button class="book-action-btn notes-btn">读书笔记</button>' : ''}
                        <button class="book-action-btn delete-btn">删除</button>
                    </div>
                </div>`;
        }).join('');

        booksGrid.querySelectorAll('.book-card').forEach(card => {
            const bookId = card.dataset.bookId;
            card.querySelector('.read-btn').addEventListener('click', (e) => { e.stopPropagation(); this.openBook(bookId); });
            card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); this.deleteBook(bookId); });
            const indexBtn = card.querySelector('.index-btn');
            if (indexBtn) indexBtn.addEventListener('click', (e) => { e.stopPropagation(); this.indexBook(bookId); });
            const notesBtn = card.querySelector('.notes-btn');
            if (notesBtn) notesBtn.addEventListener('click', (e) => { e.stopPropagation(); this.runAgentTask('generate-notes', bookId); });
            card.addEventListener('click', () => this.openBook(bookId));
        });
    }

    async openBook(bookId) {
        try {
            const response = await this.apiFetch(`/api/books/${bookId}`);
            const data = await response.json();
            if (!response.ok) { this.showToast(data.error || '打开失败'); return; }
            const book = data.book;
            if (book.format.toLowerCase() === 'txt' && data.content) {
                this.enterReadingMode(book, data.content);
            } else {
                this.showToast('该格式暂不支持在线阅读');
            }
        } catch { this.showToast('打开书籍失败'); }
    }

    async deleteBook(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book || !confirm(`确定删除《${book.title}》吗？`)) return;
        try {
            const response = await this.apiFetch(`/api/books/${bookId}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) {
                this.showToast('书籍已删除');
                this.books = this.books.filter(b => b.id !== bookId);
                this.renderBooks();
            } else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    // ==================== Reading Mode ====================

    enterReadingMode(book, content) {
        this.currentBook = book;
        this.isReading = true;
        this.currentBookContent = content;

        // Reset conversation state on book switch (per-book session isolation)
        this.currentConversationId = null;
        this.currentContextTokens = 0;
        this._chatLoadedConvId = null;
        this.updateSessionInfo(0);
        this.loadActiveConversation(book ? book.id : null);

        // Set title
        document.getElementById('readingBookTitle').textContent = book.title;

        // Format and display content
        const article = document.getElementById('readingArticle');
        article.innerHTML = this.formatTextContent(content);
        article.style.fontSize = `${this.currentFontSize}px`;

        // Update TOC
        this.updateReadingTOC();

        // Show reading view, hide bottom nav
        document.getElementById('readingView').classList.add('active');
        document.getElementById('bottomNav').classList.add('hidden');
        document.getElementById('appHeader').style.display = 'none';

        // Hide toolbars initially
        this.hideToolbars();
        this.toolbarsVisible = false;

        // Hide AI FAB initially
        document.getElementById('aiFab').classList.remove('hidden');

        // Restore scroll position
        const scrollKey = `scroll_${book.id}`;
        const savedScroll = localStorage.getItem(scrollKey);
        if (savedScroll) {
            setTimeout(() => {
                document.getElementById('readingContent').scrollTop = parseFloat(savedScroll);
            }, 100);
        }

        // Update reading theme buttons
        document.querySelectorAll('.reading-settings-panel .theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.currentTheme);
        });
    }

    exitReading() {
        this.isReading = false;
        this.currentBook = null;

        // Save scroll position
        const contentEl = document.getElementById('readingContent');
        if (this.currentBook) {
            localStorage.setItem(`scroll_${this.currentBook.id}`, contentEl.scrollTop);
        }

        // Hide reading view, show nav
        document.getElementById('readingView').classList.remove('active');
        document.getElementById('bottomNav').classList.remove('hidden');
        document.getElementById('appHeader').style.display = '';

        // Close any open panels
        this.closeAIPanel();
        this.closeTocDrawer();
        document.getElementById('readingSettingsPanel').classList.remove('open');

        // Show FAB hidden
        document.getElementById('aiFab').classList.add('hidden');

        // Refresh bookshelf
        this.loadBooks();
    }

    toggleToolbars() {
        this.toolbarsVisible = !this.toolbarsVisible;
        const top = document.getElementById('readingToolbarTop');
        const bottom = document.getElementById('readingToolbarBottom');
        const fab = document.getElementById('aiFab');
        if (this.toolbarsVisible) {
            top.classList.remove('hidden');
            bottom.classList.remove('hidden');
            fab.classList.add('hidden');
        } else {
            top.classList.add('hidden');
            bottom.classList.add('hidden');
            fab.classList.remove('hidden');
            // Also close settings panel
            document.getElementById('readingSettingsPanel').classList.remove('open');
        }
    }

    hideToolbars() {
        document.getElementById('readingToolbarTop').classList.add('hidden');
        document.getElementById('readingToolbarBottom').classList.add('hidden');
    }

    updateReadingProgress() {
        const contentEl = document.getElementById('readingContent');
        const scrollHeight = contentEl.scrollHeight - contentEl.clientHeight;
        const progress = scrollHeight > 0 ? Math.min(contentEl.scrollTop / scrollHeight, 1) : 0;
        document.getElementById('readingProgressFill').style.width = `${progress * 100}%`;

        // Save progress to server (debounced)
        if (this.currentBook && this._progressTimer) clearTimeout(this._progressTimer);
        this._progressTimer = setTimeout(() => {
            if (this.currentBook) {
                this.apiFetch(`/api/books/${this.currentBook.id}/progress`, {
                    method: 'PUT',
                    body: JSON.stringify({ progress })
                }).catch(() => {});
                localStorage.setItem(`scroll_${this.currentBook.id}`, contentEl.scrollTop);
            }
        }, 2000);
    }

    // TOC Drawer
    openTocDrawer() {
        document.getElementById('tocDrawer').classList.add('open');
        document.getElementById('tocOverlay').classList.add('visible');
    }

    closeTocDrawer() {
        document.getElementById('tocDrawer').classList.remove('open');
        document.getElementById('tocOverlay').classList.remove('visible');
    }

    updateReadingTOC() {
        const tocList = document.getElementById('tocList');
        const sections = document.querySelectorAll('#readingArticle .content-section');
        if (sections.length === 0) {
            tocList.innerHTML = '<li class="toc-item active" data-section="top">全文</li>';
            return;
        }
        let html = '';
        sections.forEach((section, i) => {
            const heading = section.querySelector('h2');
            const title = heading ? heading.textContent : `第${i + 1}节`;
            html += `<li class="toc-item${i === 0 ? ' active' : ''}" data-section="${section.id}">${this.escapeHtml(title)}</li>`;
        });
        tocList.innerHTML = html;
        tocList.querySelectorAll('.toc-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const sectionId = e.currentTarget.dataset.section;
                const el = sectionId === 'top' ? document.getElementById('readingContent') : document.getElementById(sectionId);
                if (el) {
                    if (sectionId === 'top') {
                        el.scrollTop = 0;
                    } else {
                        el.scrollIntoView({ behavior: 'smooth' });
                    }
                }
                tocList.querySelectorAll('.toc-item').forEach(t => t.classList.remove('active'));
                e.currentTarget.classList.add('active');
                this.closeTocDrawer();
            });
        });
    }

    // Reading settings panel (font/theme popup)
    toggleReadingSettings() {
        const panel = document.getElementById('readingSettingsPanel');
        panel.classList.toggle('open');
    }

    // ==================== Content Formatting ====================

    formatTextContent(content) {
        const paragraphs = content.split(/\n+/).filter(p => p.trim());
        let html = '', sectionCount = 0, inSection = false;
        paragraphs.forEach(para => {
            para = para.trim();
            if (!para) return;
            const headingMatch = para.match(/^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i);
            if (headingMatch) {
                if (inSection) html += '</section>';
                sectionCount++;
                html += `<section id="section${sectionCount}" class="content-section"><h2>${this.escapeHtml(para)}</h2>`;
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
            paragraphs.forEach(p => { if (p.trim()) html += `<p>${this.escapeHtml(p.trim())}</p>`; });
            html += '</section>';
        }
        return html;
    }

    // ==================== Font & Theme ====================

    changeFontSize(delta) {
        this.currentFontSize = Math.max(12, Math.min(28, this.currentFontSize + delta));
        localStorage.setItem('fontSize', this.currentFontSize);
        // Update all displays
        document.getElementById('fontSizeDisplay').textContent = `${this.currentFontSize}px`;
        document.getElementById('readFontSizeDisplay').textContent = `${this.currentFontSize}px`;
        // Apply to reading article
        const article = document.getElementById('readingArticle');
        if (article) article.style.fontSize = `${this.currentFontSize}px`;
    }

    changeTheme(theme) {
        if (!theme) return;
        this.currentTheme = theme;
        localStorage.setItem('theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        // Update all theme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === theme));
        document.querySelectorAll('.theme-card').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === theme));
    }

    // ==================== AI Panel ====================

    toggleAIPanel() {
        const view = document.getElementById('aiChatView');
        if (view.classList.contains('open')) this.closeAIPanel();
        else this.openAIPanel();
    }

    closeAIPanel() {
        document.getElementById('aiChatView').classList.remove('open');
        document.getElementById('aiFab').classList.remove('hidden');
    }

    async openAIPanel() {
        const view = document.getElementById('aiChatView');
        view.classList.add('open');
        document.getElementById('aiFab').classList.add('hidden');
        // Sync book name into header
        const titleMain = view.querySelector('.chat-title-main');
        if (titleMain) titleMain.textContent = this.currentBook ? this.currentBook.title : 'AI 助手';
        // Show quoted context if user came in with a text selection
        if (this.selectedText) this.setComposerContext(this.selectedText);
        // Load conversation history once per conversation
        if (this._chatLoadedConvId !== this.currentConversationId || this.chatMessages.childElementCount === 0) {
            await this.loadChatHistory();
        }
        this.questionInput.focus();
    }

    // ==================== Chat rendering ====================

    setComposerContext(text) {
        const box = document.getElementById('selectedTextBox');
        if (!box) return;
        this.selectedTextContent.textContent = text;
        box.style.display = 'flex';
    }

    clearComposerContext() {
        this.selectedText = '';
        const box = document.getElementById('selectedTextBox');
        if (box) box.style.display = 'none';
    }

    autoGrowInput() {
        const el = this.questionInput;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    showChatEmpty() {
        this.chatMessages.innerHTML = `
            <div class="chat-empty" id="chatEmpty">
                <div class="chat-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
                <p class="chat-empty-title">开始和 AI 对话</p>
                <p class="chat-empty-desc">选中原文或直接提问，AI 会结合本书内容回答你</p>
            </div>`;
    }

    hideChatEmpty() {
        const empty = document.getElementById('chatEmpty');
        if (empty) empty.remove();
    }

    scrollChatToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    renderTextInto(el, text) {
        el.innerHTML = '';
        const parts = String(text).split('\n');
        parts.forEach((part, i) => {
            if (part) el.appendChild(document.createTextNode(part));
            if (i < parts.length - 1) el.appendChild(document.createElement('br'));
        });
    }

    appendUserMessage(text, quoted) {
        this.hideChatEmpty();
        const row = document.createElement('div');
        row.className = 'chat-msg chat-msg-user';
        const col = document.createElement('div');
        col.className = 'msg-col';
        if (quoted) {
            const q = document.createElement('div');
            q.className = 'msg-quote';
            q.textContent = quoted;
            col.appendChild(q);
        }
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;
        col.appendChild(bubble);
        row.appendChild(col);
        this.chatMessages.appendChild(row);
        this.scrollChatToBottom();
        return row;
    }

    createAIMessage() {
        this.hideChatEmpty();
        const row = document.createElement('div');
        row.className = 'chat-msg chat-msg-ai';
        const avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>';
        const body = document.createElement('div');
        body.className = 'msg-body';
        const header = document.createElement('span');
        header.className = 'msg-model-tag';
        const trace = document.createElement('div');
        trace.className = 'msg-trace';
        const answer = document.createElement('div');
        answer.className = 'answer-content';
        answer.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
        body.appendChild(header);
        body.appendChild(trace);
        body.appendChild(answer);
        row.appendChild(avatar);
        row.appendChild(body);
        this.chatMessages.appendChild(row);
        this.scrollChatToBottom();
        return { row, headerEl: header, traceEl: trace, answerEl: answer };
    }

    renderStaticMessage(role, content) {
        if (role === 'user') { this.appendUserMessage(content, null); return; }
        this.hideChatEmpty();
        const row = document.createElement('div');
        row.className = 'chat-msg chat-msg-ai';
        row.innerHTML = '<div class="msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg></div><div class="msg-body"><div class="answer-content"></div></div>';
        this.renderTextInto(row.querySelector('.answer-content'), content);
        this.chatMessages.appendChild(row);
    }

    async loadChatHistory() {
        const convId = this.currentConversationId;
        this.chatMessages.innerHTML = '';
        if (!convId) { this.showChatEmpty(); this._chatLoadedConvId = null; return; }
        try {
            const resp = await this.apiFetch(`/api/conversations/${convId}/messages`);
            if (!resp.ok) { this.showChatEmpty(); return; }
            const data = await resp.json();
            const msgs = data.messages || [];
            if (data.conversation && typeof data.conversation.tokenEstimate === 'number') {
                this.updateSessionInfo(data.conversation.tokenEstimate, data.conversation.contextLimit);
            }
            if (!msgs.length) { this.showChatEmpty(); }
            else { msgs.forEach(m => this.renderStaticMessage(m.role, m.content)); }
            this._chatLoadedConvId = convId;
            this.scrollChatToBottom();
        } catch { this.showChatEmpty(); }
    }


    // ==================== Text Selection & AI ====================

    handleTextSelection(e) {
        if (this.floatingToolbar.contains(e.target) || document.getElementById('aiChatView').contains(e.target)) return;
        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            if (text.length > 0 && this.isReading) {
                this.selectedText = text;
                this.showFloatingToolbar(selection);
            } else {
                this.hideFloatingToolbar();
            }
        }, 10);
    }

    handleMouseDown(e) {
        if (!this.floatingToolbar.contains(e.target) && !document.getElementById('aiChatView').contains(e.target)) {
            this.hideFloatingToolbar();
        }
    }

    showFloatingToolbar(selection) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this.floatingToolbar.style.visibility = 'hidden';
        this.floatingToolbar.style.display = 'flex';
        const w = this.floatingToolbar.offsetWidth || 240;
        const h = this.floatingToolbar.offsetHeight || 40;
        let left = rect.left + (rect.width / 2) - (w / 2);
        let top = rect.top - h - 8;
        if (top < 10) top = rect.bottom + 8;
        left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
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
        if (action === 'ask') { this.openAIPanel(); }
        else { this.executeAction(action); }
        this.hideFloatingToolbar();
    }

    isProviderConfigured() {
        const providerData = this.apiProviders[this.currentProvider];
        return providerData && providerData.hasKey;
    }

    handleQuickAction(e) { this.executeAction(e.currentTarget.dataset.action); }

    async executeAction(action) {
        if (!this.selectedText) { this.showToast('请先选中要提问的文本'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        const actionMap = {
            'explain': '请解释这段文字的含义',
            'summarize': '请总结这段文字的要点',
            'translate': '请将这段文字翻译成英文',
            'expand': '请提供与这段文字相关的扩展知识'
        };
        await this.openAIPanel();
        await this.askAI(actionMap[action] || action);
    }

    async handleAskQuestion() {
        const question = this.questionInput.value.trim();
        if (!question) { this.showToast('请输入问题'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        await this.askAI(question);
    }

    async askAI(question) {
        if (this.agentMode) return this.askAgent(question);
        const quoted = this.selectedText || '';
        this.setAsking(true);
        this.appendUserMessage(question, quoted);
        this.clearComposerContext();
        this.questionInput.value = '';
        this.autoGrowInput();
        const msg = this.createAIMessage();
        const answerEl = msg.answerEl;

        try {
            const response = await this.apiFetch('/api/ask-stream', {
                method: 'POST',
                body: JSON.stringify({
                    text: quoted, question, bookName: this.getCurrentBookName(),
                    provider: this.currentProvider, model: this.currentModel,
                    bookId: this.currentBook ? this.currentBook.id : null,
                    conversationId: this.currentConversationId
                })
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.needApiKey) {
                    const pi = this.providers.find(p => p.id === (data.provider || this.currentProvider));
                    answerEl.innerHTML = `<p style="color:#ef4444;">需要配置 ${pi ? pi.name : 'AI'} 的 API 密钥</p>`;
                    this.checkApiKeyStatus();
                } else {
                    answerEl.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(data.error)}</p>`;
                }
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', fullContent = '', pendingChunk = '', rafId = null, started = false;

            const flushChunk = () => {
                if (!pendingChunk) return;
                const text = pendingChunk;
                pendingChunk = '';
                const parts = text.split('\n');
                parts.forEach((part, i) => {
                    if (part) answerEl.appendChild(document.createTextNode(part));
                    if (i < parts.length - 1) answerEl.appendChild(document.createElement('br'));
                });
                this.scrollChatToBottom();
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) { if (rafId) cancelAnimationFrame(rafId); flushChunk(); break; }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6);
                    if (!dataStr.trim()) continue;
                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.type === 'start') {
                            if (parsed.conversationId) this.currentConversationId = parsed.conversationId;
                            if (typeof parsed.tokens === 'number') this.updateSessionInfo(parsed.tokens, parsed.limit);
                            msg.headerEl.textContent = `${parsed.provider} · ${parsed.model}`;
                            msg.headerEl.classList.add('show');
                            answerEl.innerHTML = '';
                            started = true;
                        } else if (parsed.type === 'chunk') {
                            if (!started) { answerEl.innerHTML = ''; started = true; }
                            fullContent += parsed.content;
                            pendingChunk += parsed.content;
                            if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; flushChunk(); });
                        } else if (parsed.type === 'compressed') {
                            this.showToast(`已自动压缩上下文，节省约 ${parsed.saved || 0} tokens`);
                            this.updateSessionInfo(parsed.tokens, parsed.limit);
                        } else if (parsed.type === 'session_update') {
                            this.updateSessionInfo(parsed.tokens, parsed.limit);
                        } else if (parsed.type === 'end') {
                            if (parsed.conversationId) this.currentConversationId = parsed.conversationId;
                            this.saveToHistory(quoted, question, fullContent);
                        } else if (parsed.type === 'error') {
                            answerEl.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(parsed.error)}</p>`;
                        }
                    } catch {}
                }
            }
        } catch {
            answerEl.innerHTML = '<p style="color:#ef4444;">网络错误</p>';
        } finally {
            this.setAsking(false);
            this._chatLoadedConvId = this.currentConversationId;
            this.scrollChatToBottom();
        }
    }

    setAsking(loading) {
        this.askBtn.classList.toggle('loading', loading);
        this.askBtn.disabled = loading;
        this.questionInput.disabled = loading;
    }


    // ==================== Agent (Function Calling + RAG + Multi-Agent) ====================

    async askAgent(question) {
        const quoted = this.selectedText || '';
        this.setAsking(true);
        this.appendUserMessage(question, quoted);
        this.clearComposerContext();
        this.questionInput.value = '';
        this.autoGrowInput();
        const msg = this.createAIMessage();
        const answerEl = msg.answerEl;
        const traceEl = msg.traceEl;

        try {
            const response = await this.apiFetch('/api/agent/stream', {
                method: 'POST',
                body: JSON.stringify({
                    text: quoted, question, bookName: this.getCurrentBookName(),
                    provider: this.currentProvider, model: this.currentModel,
                    bookId: this.currentBook ? this.currentBook.id : null,
                    conversationId: this.currentConversationId
                })
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.needApiKey) {
                    const pi = this.providers.find(p => p.id === (data.provider || this.currentProvider));
                    answerEl.innerHTML = `<p style="color:#ef4444;">需要配置 ${pi ? pi.name : 'AI'} 的 API 密钥</p>`;
                    this.checkApiKeyStatus();
                } else {
                    answerEl.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(data.error)}</p>`;
                }
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', fullContent = '', pendingChunk = '', rafId = null, finalStarted = false;

            const flushChunk = () => {
                if (!pendingChunk) return;
                const text = pendingChunk;
                pendingChunk = '';
                const parts = text.split('\n');
                parts.forEach((part, i) => {
                    if (part) answerEl.appendChild(document.createTextNode(part));
                    if (i < parts.length - 1) answerEl.appendChild(document.createElement('br'));
                });
                this.scrollChatToBottom();
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) { if (rafId) cancelAnimationFrame(rafId); flushChunk(); break; }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'start') {
                            msg.headerEl.textContent = `${evt.provider} · ${evt.model}`;
                            msg.headerEl.classList.add('show');
                            answerEl.innerHTML = '';
                        } else if (evt.type === 'session') {
                            if (evt.conversationId) this.currentConversationId = evt.conversationId;
                            if (typeof evt.tokens === 'number') this.updateSessionInfo(evt.tokens, evt.limit);
                        } else if (evt.type === 'thought') {
                            this.appendTraceItem(traceEl, 'thought', `💭 思考：${evt.content}`, evt.iteration);
                        } else if (evt.type === 'tool_call') {
                            this.appendTraceItem(traceEl, 'tool_call', `🔧 调用工具：${evt.name}(${JSON.stringify(evt.args)})`, evt.iteration);
                        } else if (evt.type === 'tool_result') {
                            const rs = JSON.stringify(evt.result);
                            const failed = evt.result && evt.result.error;
                            const icon = failed ? '❌' : '✅';
                            this.appendTraceItem(traceEl, failed ? 'tool_error' : 'tool_result', `${icon} 结果：${rs.substring(0, 200)}${rs.length > 200 ? '...' : ''}（${evt.elapsed}ms）`, evt.iteration);
                        } else if (evt.type === 'fallback') {
                            this.appendTraceItem(traceEl, 'fallback', `⚠️ ${evt.reason}`);
                        } else if (evt.type === 'final_start') {
                            answerEl.innerHTML = '';
                            finalStarted = true;
                        } else if (evt.type === 'chunk') {
                            if (!finalStarted) { answerEl.innerHTML = ''; finalStarted = true; }
                            fullContent += evt.content;
                            pendingChunk += evt.content;
                            if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; flushChunk(); });
                        } else if (evt.type === 'compressed') {
                            this.showToast(`已自动压缩上下文，节省约 ${evt.saved || 0} tokens`);
                            this.updateSessionInfo(evt.tokens, evt.limit);
                        } else if (evt.type === 'session_update') {
                            this.updateSessionInfo(evt.tokens, evt.limit);
                        } else if (evt.type === 'end') {
                            if (evt.conversationId) this.currentConversationId = evt.conversationId;
                            this.saveToHistory(quoted, question, fullContent);
                        } else if (evt.type === 'error') {
                            answerEl.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(evt.error)}</p>`;
                        }
                    } catch {}
                }
            }
        } catch {
            answerEl.innerHTML = '<p style="color:#ef4444;">网络错误</p>';
        } finally {
            this.setAsking(false);
            this._chatLoadedConvId = this.currentConversationId;
            this.scrollChatToBottom();
        }
    }

    appendTraceItem(traceEl, cls, text, iteration) {
        if (!traceEl) return;
        traceEl.classList.add('show');
        const item = document.createElement('div');
        item.className = `trace-item trace-${cls}`;
        item.innerHTML = `<span class="trace-iter">${iteration ? `#${iteration} ` : ''}</span>${this.escapeHtml(text)}`;
        traceEl.appendChild(item);
        traceEl.scrollTop = traceEl.scrollHeight;
        this.scrollChatToBottom();
    }


    // ==================== Session Management ====================

    updateSessionInfo(tokens, limit) {
        if (typeof tokens === 'number') this.currentContextTokens = tokens;
        if (typeof limit === 'number' && limit > 0) this.currentContextLimit = limit;
        const el = document.getElementById('sessionInfo');
        if (!el) return;
        const used = this.currentContextTokens || 0;
        const lim = this.currentContextLimit || 0;
        if (lim > 0) {
            const pct = (used / lim) * 100;
            const pctText = pct < 1 && used > 0 ? '<1' : String(Math.round(pct));
            el.textContent = `上下文：${this.formatTokens(used)} / ${this.formatTokens(lim)}（${pctText}%）`;
        } else {
            el.textContent = `上下文：${this.formatTokens(used)} tokens`;
        }
    }

    formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    async loadActiveConversation(bookId) {
        if (!bookId || this._openingConv) return;
        try {
            const response = await this.apiFetch(`/api/conversations/active?bookId=${encodeURIComponent(bookId)}`);
            if (!response.ok) return;
            const data = await response.json();
            const c = data.conversation;
            if (c && this.currentBook && this.currentBook.id === bookId) {
                this.currentConversationId = c.id;
                this.updateSessionInfo(c.tokenEstimate || 0, c.contextLimit);
            }
        } catch {}
    }

    async newConversation() {
        if (!this.currentBook) { this.showToast('请先打开一本书'); return; }
        try {
            const response = await this.apiFetch('/api/conversations', {
                method: 'POST',
                body: JSON.stringify({
                    bookId: this.currentBook.id,
                    provider: this.currentProvider, model: this.currentModel
                })
            });
            const data = await response.json();
            if (data.conversation) {
                this.currentConversationId = data.conversation.id;
                this._chatLoadedConvId = data.conversation.id;
                this.updateSessionInfo(data.conversation.tokenEstimate || 0, data.conversation.contextLimit);
                this.showChatEmpty();
                this.showToast('已开始新对话');
            } else {
                this.showToast(data.error || '新建对话失败');
            }
        } catch { this.showToast('新建对话失败'); }
    }

    async compressContext() {
        if (!this.currentConversationId) { this.showToast('当前还没有对话可压缩'); return; }
        const btn = document.getElementById('compressBtn');
        if (btn) { btn.disabled = true; btn.textContent = '🗜️ 压缩中...'; }
        try {
            const response = await this.apiFetch(`/api/conversations/${this.currentConversationId}/compress`, {
                method: 'POST',
                body: JSON.stringify({ provider: this.currentProvider })
            });
            const data = await response.json();
            if (data.success && data.compressed) {
                const saved = Math.max(0, (data.before || 0) - (data.after || 0));
                this.updateSessionInfo(data.after || 0);
                this.showToast(`压缩完成，节省约 ${saved} tokens`);
            } else if (data.success) {
                this.showToast('当前上下文较短，暂无需压缩');
            } else {
                this.showToast(data.error || '压缩失败');
            }
        } catch { this.showToast('压缩失败'); }
        finally { if (btn) { btn.disabled = false; btn.textContent = '🗜️ 压缩'; } }
    }

    // ==================== Memory Management ====================

    async openMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (modal) modal.style.display = 'flex';
        await this.loadMemories();
    }

    closeMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (modal) modal.style.display = 'none';
    }

    async loadMemories() {
        const listEl = document.getElementById('memoryList');
        if (listEl) listEl.innerHTML = '<p class="memory-empty">加载中...</p>';
        try {
            const response = await this.apiFetch('/api/memories');
            const data = await response.json();
            this.renderMemories(data.memories || []);
        } catch {
            if (listEl) listEl.innerHTML = '<p class="memory-empty">加载失败</p>';
        }
    }

    renderMemories(memories) {
        const listEl = document.getElementById('memoryList');
        if (!listEl) return;
        if (!memories.length) {
            listEl.innerHTML = '<p class="memory-empty">还没有记忆。多和 AI 聊聊，它会记住你的偏好与兴趣。</p>';
            return;
        }
        const kindLabel = { preference: '偏好', fact: '事实', interest: '兴趣' };
        listEl.innerHTML = memories.map(m => `
            <div class="memory-item" data-id="${m.id}">
                <span class="memory-kind memory-kind-${m.kind}">${kindLabel[m.kind] || m.kind}</span>
                <span class="memory-content">${this.escapeHtml(m.content)}</span>
                <button class="memory-delete-btn" data-id="${m.id}" title="删除这条记忆">×</button>
            </div>
        `).join('');
        listEl.querySelectorAll('.memory-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => this.deleteMemory(Number(btn.dataset.id)));
        });
    }

    async deleteMemory(id) {
        try {
            await this.apiFetch(`/api/memories/${id}`, { method: 'DELETE' });
            const item = document.querySelector(`.memory-item[data-id="${id}"]`);
            if (item) item.remove();
            const listEl = document.getElementById('memoryList');
            if (listEl && !listEl.querySelector('.memory-item')) this.renderMemories([]);
        } catch { this.showToast('删除失败'); }
    }

    async clearAllMemories() {
        if (!confirm('确定清空所有 AI 记忆吗？此操作不可撤销。')) return;
        try {
            await this.apiFetch('/api/memories', { method: 'DELETE' });
            this.renderMemories([]);
            this.showToast('已清空所有记忆');
        } catch { this.showToast('清空失败'); }
    }


    async indexBook(bookId, force = false) {
        // 建索引不依赖对话提供商密钥（向量化由 RAG 设置解析，未配置时后端自动降级 BM25），不做密钥门槛拦截
        const book = this.books.find(b => b.id === bookId);

        // 非强制重建时，先查索引状态；已索引则提供重建/删除选项，避免重复耗时重建
        if (!force) {
            try {
                const res = await this.apiFetch(`/api/books/${bookId}/index-status`);
                if (res.ok) {
                    const st = await res.json();
                    if (st.indexed) { this.showIndexExistingModal(bookId, book, st); return; }
                }
            } catch {}
        }
        this.doIndexBook(bookId, book);
    }

    async doIndexBook(bookId, book) {
        this.openTaskModal('建立智能索引');
        this.appendTaskLog(`<div class="log-info">正在为《${book ? book.title : ''}》建立 RAG 索引...</div>`);
        this.setTaskProgress(30, '正在分块与向量化...');
        try {
            const response = await this.apiFetch(`/api/books/${bookId}/index`, {
                method: 'POST',
                body: JSON.stringify({})
            });
            const data = await response.json();
            if (response.ok) {
                const modeText = data.mode === 'embedding+bm25' ? '向量+BM25' : 'BM25 关键词';
                this.appendTaskLog(`<div class="log-success">✅ 索引完成：${data.chunkCount} 个文本块，模式：${modeText}</div>`);
                if (data.embedError) {
                    this.appendTaskLog(`<div class="log-error">⚠️ 向量化失败已降级 BM25：${data.embedError}</div>`);
                }
                this.setTaskProgress(100, '索引完成');
            } else {
                this.appendTaskLog(`<div class="log-error">❌ ${data.error}</div>`);
                this.setTaskProgress(0, '索引失败');
            }
        } catch {
            this.appendTaskLog(`<div class="log-error">❌ 网络错误</div>`);
        }
    }

    // 已存在索引时：展示状态并提供 重建/删除 选项
    showIndexExistingModal(bookId, book, st) {
        const modeText = st.mode === 'embedding+bm25' ? '向量+BM25' : 'BM25 关键词';
        const timeText = st.indexedAt ? new Date(st.indexedAt).toLocaleString('zh-CN') : '';
        this.openTaskModal('建立智能索引');
        document.getElementById('taskProgress').style.display = 'none';
        this.appendTaskLog(`<div class="log-success">✅ 《${book ? book.title : ''}》已建立索引</div>`);
        this.appendTaskLog(`<div class="log-info">文本块：${st.chunkCount} 个 · 模式：${modeText}${timeText ? ` · 时间：${timeText}` : ''}</div>`);
        this.appendTaskLog(`<div class="log-progress">无需重复建立。如需更新可选择重建，或不再需要时删除索引。</div>`);
        this.setTaskActions([
            { label: '🗑️ 删除索引', onClick: () => this.deleteBookIndex(bookId) },
            { label: '🔄 重建索引', primary: true, onClick: () => this.indexBook(bookId, true) }
        ]);
        this.agentTaskModal.classList.add('visible');
    }

    async deleteBookIndex(bookId) {
        if (!confirm('确定删除该书的 RAG 索引吗？')) return;
        try {
            const res = await this.apiFetch(`/api/books/${bookId}/index`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { this.showToast('索引已删除'); this.closeTaskModal(); }
            else this.showToast(data.error || '删除失败');
        } catch { this.showToast('删除失败'); }
    }

    async runAgentTask(taskType, bookId, force = false) {
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        const book = this.books.find(b => b.id === bookId);
        const titleMap = { 'generate-notes': '生成读书笔记', 'character-analysis': '人物关系分析' };

        // 非强制重生成时，优先复用已保存的结果
        if (!force) {
            try {
                const res = await this.apiFetch(`/api/agent/task/result?bookId=${encodeURIComponent(bookId)}&taskType=${encodeURIComponent(taskType)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.result && data.result.content) {
                        this.showSavedTaskResult(taskType, bookId, data.result.content, data.result.updatedAt);
                        return;
                    }
                }
            } catch {}
        }

        this.openTaskModal(titleMap[taskType] || 'AI 智能任务');
        this.appendTaskLog(`<div class="log-info">开始为《${book ? book.title : ''}》执行：${titleMap[taskType] || taskType}</div>`);

        try {
            const response = await this.apiFetch('/api/agent/task', {
                method: 'POST',
                body: JSON.stringify({ taskType, bookId, provider: this.currentProvider, model: this.currentModel })
            });
            if (!response.ok) {
                const data = await response.json();
                this.appendTaskLog(`<div class="log-error">❌ ${data.error}</div>`);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'task_start') {
                            this.appendTaskLog(`<div class="log-info">📋 任务：${evt.taskName}（${evt.nodes.length} 个子 Agent 并行编排）</div>`);
                        } else if (evt.type === 'node_start') {
                            this.appendTaskLog(`<div class="log-node">▶️ ${evt.name} 启动</div>`);
                            this.setTaskProgress(this._taskPercent || 0, `${evt.name} 运行中…`);
                        } else if (evt.type === 'node_progress') {
                            this.appendTaskLog(`<div class="log-progress"> ${evt.stage || ''}</div>`);
                            if (evt.stage) this.setTaskProgress(this._taskPercent || 0, evt.stage);
                        } else if (evt.type === 'node_done') {
                            this.appendTaskLog(`<div class="log-success">✅ ${evt.name} 完成</div>`);
                        } else if (evt.type === 'node_error') {
                            this.appendTaskLog(`<div class="log-error">⚠️ ${evt.name} 失败：${evt.error}（已降级跳过）</div>`);
                        } else if (evt.type === 'progress') {
                            this._taskPercent = evt.percent;
                            this.setTaskProgress(evt.percent, `${evt.progress}/${evt.total} 节点完成`);
                        } else if (evt.type === 'result') {
                            const final = evt.final || {};
                            const content = final.note || final.report || '';
                            if (content) {
                                this.renderTaskResult(content);
                                this._taskContext = { taskType, bookId, content };
                                this.showTaskResultActions(taskType, bookId);
                            } else this.appendTaskLog(`<div class="log-error">⚠️ 任务未产生有效结果，请检查 API 密钥与模型是否可用（模型不支持或超时会导致所有子 Agent 降级失败）</div>`);
                        } else if (evt.type === 'task_done') {
                            this.setTaskProgress(100, '任务完成');
                        } else if (evt.type === 'error') {
                            this.appendTaskLog(`<div class="log-error">❌ ${evt.error}</div>`);
                        }
                    } catch {}
                }
            }
        } catch {
            this.appendTaskLog(`<div class="log-error">❌ 网络错误</div>`);
        }
    }

    openTaskModal(title) {
        document.getElementById('agentTaskTitle').textContent = title || 'AI 智能任务';
        document.getElementById('taskLog').innerHTML = '';
        document.getElementById('taskResult').style.display = 'none';
        document.getElementById('taskResult').innerHTML = '';
        document.getElementById('taskProgress').style.display = 'block';
        this.setTaskActions([]);
        this._taskPercent = 0;
        this.setTaskProgress(0, '准备中...');
        this.agentTaskModal.classList.add('visible');
    }

    // 动态设置任务弹窗的操作按钮
    setTaskActions(actions) {
        const bar = document.getElementById('taskActionBar');
        if (!bar) return;
        if (!actions || !actions.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
        bar.innerHTML = '';
        actions.forEach(a => {
            const btn = document.createElement('button');
            btn.className = `btn ${a.primary ? 'btn-primary' : 'btn-secondary'}`;
            btn.textContent = a.label;
            btn.addEventListener('click', a.onClick);
            bar.appendChild(btn);
        });
        bar.style.display = 'flex';
    }

    // 展示已保存的任务结果（无需重新生成）
    showSavedTaskResult(taskType, bookId, content, updatedAt) {
        const titleMap = { 'generate-notes': '读书笔记', 'character-analysis': '人物关系分析' };
        document.getElementById('agentTaskTitle').textContent = titleMap[taskType] || 'AI 智能任务';
        document.getElementById('taskLog').innerHTML = '';
        document.getElementById('taskProgress').style.display = 'none';
        this._taskContext = { taskType, bookId, content };
        this.renderTaskResult(content);
        this.showTaskResultActions(taskType, bookId, updatedAt);
        this.agentTaskModal.classList.add('visible');
    }

    // 结果视图的操作按钮：导出 / 查看阅读 / 重新生成
    showTaskResultActions(taskType, bookId, updatedAt) {
        const timeText = updatedAt ? `（生成于 ${new Date(updatedAt).toLocaleString('zh-CN')}）` : '';
        this.appendTaskLog(`<div class="log-success">✅ 已展示上次生成的结果${timeText}，可导出或重新生成</div>`);
        this.setTaskActions([
            { label: '📥 导出 Markdown', onClick: () => this.exportTaskResult() },
            { label: '📖 查看阅读', onClick: () => { this.closeTaskModal(); this.openBook(bookId); } },
            { label: '🔄 重新生成', primary: true, onClick: () => this.runAgentTask(taskType, bookId, true) }
        ]);
    }

    // 导出任务结果为 .md 文件
    exportTaskResult() {
        const ctx = this._taskContext;
        if (!ctx || !ctx.content) { this.showToast('暂无可导出的内容'); return; }
        const book = this.books.find(b => b.id === ctx.bookId);
        const nameMap = { 'generate-notes': '读书笔记', 'character-analysis': '人物关系分析' };
        const fname = `《${book ? book.title : ''}》${nameMap[ctx.taskType] || 'AI任务'}.md`;
        const blob = new Blob([ctx.content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        this.showToast('已导出');
    }

    closeTaskModal() {
        this.agentTaskModal.classList.remove('visible');
    }

    appendTaskLog(html) {
        const log = document.getElementById('taskLog');
        const line = document.createElement('div');
        line.innerHTML = html;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    }

    setTaskProgress(percent, text) {
        document.getElementById('taskProgressFill').style.width = percent + '%';
        document.getElementById('taskProgressText').textContent = text;
    }

    renderTaskResult(content) {
        const result = document.getElementById('taskResult');
        result.style.display = 'block';
        result.innerHTML = this.renderMarkdown(content);
    }

    renderMarkdown(text) {
        if (!text) return '';
        let html = this.escapeHtml(text);
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    // ==================== Providers ====================

    async loadProviders() {
        try {
            const response = await this.apiFetch('/api/providers');
            const data = await response.json();
            this.providers = data.providers || [];
            this.renderProviderTabs();
            this.switchProvider(this.currentProvider);
        } catch (error) { console.error('加载提供商失败:', error); }
    }

    renderProviderTabs() {
        let html = this.providers.filter(p => !p.isCustom).map(p =>
            `<button class="provider-tab${p.id === this.currentProvider ? ' active' : ''}" data-provider="${p.id}">${p.name}</button>`
        ).join('');
        html += `<button class="provider-tab" data-provider="custom">+ 自定义</button>`;
        this.providerTabs.innerHTML = html;
        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const provider = e.currentTarget.dataset.provider;
                if (provider === 'custom') this.showCustomProviderView();
                else this.switchProvider(provider);
            });
        });
    }

    switchProvider(provider) {
        this.currentProvider = provider;
        this.currentModel = localStorage.getItem(`selectedModel_${provider}`) || null;
        localStorage.setItem('selectedProvider', provider);
        this.providerTabs.querySelectorAll('.provider-tab').forEach(tab => {
            const isCustom = this.providers.find(p => p.id === provider && p.isCustom);
            tab.classList.toggle('active', isCustom ? tab.dataset.provider === 'custom' : tab.dataset.provider === provider);
        });
        const providerInfo = this.providers.find(p => p.id === provider);
        if (!providerInfo) return;

        // 选中具体提供商时，密钥状态块与其相关，恢复显示
        document.getElementById('apiKeyStatus').style.display = 'block';

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
        if (this.apiKeyLabel) this.apiKeyLabel.textContent = `${providerInfo.name} API密钥`;
        if (this.apiKeyHint) {
            if (providerInfo.id === 'zhipu') this.apiKeyHint.innerHTML = `获取密钥：访问 <a href="https://open.bigmodel.cn/" target="_blank">智谱AI</a>`;
            else if (providerInfo.id === 'siliconflow') this.apiKeyHint.innerHTML = `获取密钥：访问 <a href="https://cloud.siliconflow.cn/" target="_blank">硅基流动</a>`;
            else this.apiKeyHint.innerHTML = `请输入 ${providerInfo.name} API密钥`;
        }
        if (this.modelSelectGroup) {
            const models = this.getProviderModels(providerInfo);
            if (models.length > 0) {
                this.modelSelectGroup.style.display = 'block';
                const savedModel = this.currentModel || providerInfo.defaultModel;
                this.currentModel = savedModel;
                this.modelSelect.innerHTML = models.map(m => `<option value="${m.id}"${m.id === savedModel ? ' selected' : ''}>${m.name}</option>`).join('');
                this.modelSelect.onchange = (e) => { this.currentModel = e.target.value; localStorage.setItem(`selectedModel_${provider}`, e.target.value); if (this.modelValue) this.modelValue.textContent = e.target.value; };
                if (this.modelValue) this.modelValue.textContent = savedModel;
            } else { this.modelSelectGroup.style.display = 'none'; }
        }
        if (this.apiInfoList && !providerInfo.isCustom) {
            if (providerInfo.id === 'zhipu') this.apiInfoList.innerHTML = '<li>API密钥AES-256加密存储</li><li>密钥仅用于调用AI服务</li><li>可随时删除密钥</li><li>推荐 glm-4.5-air 模型</li>';
            else if (providerInfo.id === 'siliconflow') this.apiInfoList.innerHTML = '<li>API密钥AES-256加密存储</li><li>密钥仅用于调用AI服务</li><li>新用户注册送代金券</li>';
            else this.apiInfoList.innerHTML = `<li>API密钥AES-256加密存储</li><li>密钥仅用于${providerInfo.name}服务</li>`;
        }
        const apiKeyInput = document.getElementById('apiKeyInput');
        if (apiKeyInput) apiKeyInput.value = '';
        this.renderCustomProvidersList();
        this.renderCustomModelTags(provider);
        this.checkApiKeyStatus();
    }

    getCustomModels(providerId) { try { return JSON.parse(localStorage.getItem(`customModels_${providerId}`)) || []; } catch { return []; } }
    saveCustomModels(providerId, models) { localStorage.setItem(`customModels_${providerId}`, JSON.stringify(models)); }

    addCustomModel() {
        const input = document.getElementById('customModelId');
        const modelId = input.value.trim();
        if (!modelId) { this.showToast('请输入模型ID'); return; }
        const customModels = this.getCustomModels(this.currentProvider);
        if (customModels.some(m => m.id === modelId)) { this.showToast('模型已存在'); return; }
        const pi = this.providers.find(p => p.id === this.currentProvider);
        if ((pi?.models || []).some(m => m.id === modelId) || pi?.defaultModel === modelId) { this.showToast('模型已在默认列表中'); return; }
        customModels.push({ id: modelId, name: modelId });
        this.saveCustomModels(this.currentProvider, customModels);
        input.value = '';
        this.showToast(`已添加: ${modelId}`);
        this.switchProvider(this.currentProvider);
    }

    removeCustomModel(providerId, modelId) {
        let customModels = this.getCustomModels(providerId).filter(m => m.id !== modelId);
        this.saveCustomModels(providerId, customModels);
        if (this.currentModel === modelId) { const pi = this.providers.find(p => p.id === providerId); this.currentModel = pi?.defaultModel || null; localStorage.setItem(`selectedModel_${providerId}`, this.currentModel || ''); }
        this.switchProvider(providerId);
    }

    renderCustomModelTags(providerId) {
        const c = document.getElementById('customModelTags');
        if (!c) return;
        const customModels = this.getCustomModels(providerId);
        if (!customModels.length) { c.innerHTML = ''; return; }
        c.innerHTML = customModels.map(m => `<span class="model-tag">${this.escapeHtml(m.name)}<button class="tag-remove" data-model-id="${this.escapeHtml(m.id)}">×</button></span>`).join('');
        c.querySelectorAll('.tag-remove').forEach(btn => btn.addEventListener('click', () => this.removeCustomModel(providerId, btn.dataset.modelId)));
    }

    getProviderModels(providerInfo) {
        const models = [], addedIds = new Set();
        if (providerInfo.defaultModel) { models.push({ id: providerInfo.defaultModel, name: providerInfo.defaultModel }); addedIds.add(providerInfo.defaultModel); }
        (providerInfo.models || []).forEach(m => { if (!addedIds.has(m.id)) { models.push(m); addedIds.add(m.id); } });
        this.getCustomModels(providerInfo.id).forEach(m => { if (!addedIds.has(m.id)) { models.push(m); addedIds.add(m.id); } });
        return models;
    }

    showCustomProviderView() {
        this.providerTabs.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === 'custom'));
        document.querySelector('.api-key-form').style.display = 'none';
        document.getElementById('apiInfoSection').style.display = 'none';
        // 自定义"添加/列表"视图与单个内置提供商的密钥状态无关，隐藏该状态块避免误导
        document.getElementById('apiKeyStatus').style.display = 'none';
        document.getElementById('customProvidersSection').style.display = 'block';
        document.getElementById('addProviderForm').style.display = 'block';
        this.renderCustomProvidersList();
    }

    showCustomProviderSettings(providerId) {
        const pi = this.providers.find(p => p.id === providerId);
        if (!pi) return;
        this.currentProvider = providerId;
        this.currentModel = localStorage.getItem(`selectedModel_${providerId}`) || null;
        localStorage.setItem('selectedProvider', providerId);
        this.providerTabs.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === 'custom'));
        document.querySelector('.api-key-form').style.display = 'block';
        document.getElementById('apiKeyStatus').style.display = 'block';
        document.getElementById('customProvidersSection').style.display = 'block';
        document.getElementById('addProviderForm').style.display = 'none';
        document.getElementById('apiInfoSection').style.display = 'none';
        if (this.apiKeyLabel) this.apiKeyLabel.textContent = `${pi.name} API密钥`;
        if (this.apiKeyHint) this.apiKeyHint.innerHTML = `请输入 ${pi.name} API密钥`;
        if (this.modelSelectGroup) {
            const models = this.getProviderModels(pi);
            if (models.length > 0) {
                this.modelSelectGroup.style.display = 'block';
                const savedModel = this.currentModel || pi.defaultModel;
                this.modelSelect.innerHTML = models.map(m => `<option value="${m.id}"${m.id === savedModel ? ' selected' : ''}>${m.name}</option>`).join('');
                this.modelSelect.onchange = (e) => { this.currentModel = e.target.value; localStorage.setItem(`selectedModel_${providerId}`, e.target.value); };
            } else { this.modelSelectGroup.style.display = 'none'; }
        }
        this.renderCustomProvidersList();
        this.checkApiKeyStatus();
    }

    renderCustomProvidersList() {
        const container = document.getElementById('customProvidersList');
        const customProviders = this.providers.filter(p => p.isCustom);
        if (!customProviders.length) { container.innerHTML = '<p class="empty-custom">暂无自定义提供商</p>'; return; }
        container.innerHTML = customProviders.map(p => {
            const isActive = p.id === this.currentProvider;
            const models = this.getProviderModels(p);
            let modelSelector = '';
            if (models.length > 0) {
                const sel = this.currentModel || p.defaultModel;
                modelSelector = `<div class="model-selector-inline"><label>模型：</label><select class="custom-model-select" data-provider-id="${p.id}">${models.map(m => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${m.name}</option>`).join('')}</select></div>`;
            }
            return `<div class="custom-provider-item${isActive ? ' active' : ''}" data-provider-id="${p.id}"><div class="custom-provider-info"><div class="custom-provider-name">${this.escapeHtml(p.name)}</div><div class="custom-provider-id">ID: ${p.id}</div>${modelSelector}</div><div class="custom-provider-actions"><button class="btn btn-primary btn-sm select-provider-btn" data-provider="${p.id}">选择</button><button class="btn btn-danger btn-sm delete-provider-btn" data-provider="${p.id}">删除</button></div></div>`;
        }).join('');
        container.querySelectorAll('.select-provider-btn').forEach(b => b.addEventListener('click', (e) => this.showCustomProviderSettings(e.currentTarget.dataset.provider)));
        container.querySelectorAll('.delete-provider-btn').forEach(b => b.addEventListener('click', (e) => this.deleteCustomProvider(e.currentTarget.dataset.provider)));
        container.querySelectorAll('.custom-model-select').forEach(s => s.addEventListener('change', (e) => {
            const pid = e.currentTarget.dataset.providerId;
            this.currentProvider = pid;
            this.currentModel = e.target.value;
            localStorage.setItem('selectedProvider', pid);
            localStorage.setItem(`selectedModel_${pid}`, e.target.value);
        }));
    }

    async addCustomProvider() {
        const name = document.getElementById('customProviderName').value.trim();
        const apiEndpoint = document.getElementById('customProviderEndpoint').value.trim();
        const defaultModel = document.getElementById('customProviderModel').value.trim();
        const modelsStr = document.getElementById('customProviderModels').value.trim();
        const apiKey = document.getElementById('customProviderApiKey').value.trim();
        if (!name || !apiEndpoint || !defaultModel || !apiKey) { this.showToast('请填写所有必填项'); return; }
        let models = null;
        if (modelsStr) { try { models = JSON.parse(modelsStr); if (!Array.isArray(models)) { this.showToast('模型列表必须是JSON数组'); return; } } catch { this.showToast('JSON格式错误'); return; } }
        const btn = document.getElementById('addProviderBtn');
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const response = await this.apiFetch('/api/providers', { method: 'POST', body: JSON.stringify({ name, apiEndpoint, defaultModel, models, apiKey }) });
            const data = await response.json();
            if (response.ok) {
                this.showToast('自定义提供商添加成功！');
                ['customProviderName', 'customProviderEndpoint', 'customProviderModel', 'customProviderModels', 'customProviderApiKey'].forEach(id => document.getElementById(id).value = '');
                await this.loadProviders();
            } else { this.showToast(data.error || '添加失败'); }
        } catch { this.showToast('添加失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async deleteCustomProvider(providerId) {
        const p = this.providers.find(x => x.id === providerId);
        if (!p || !confirm(`确定删除 "${p.name}" 吗？`)) return;
        try {
            const response = await this.apiFetch(`/api/providers/${providerId}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) {
                this.showToast('已删除');
                if (this.currentProvider === providerId) { this.currentProvider = 'zhipu'; localStorage.setItem('selectedProvider', 'zhipu'); }
                await this.loadProviders();
                this.checkApiKeyStatus();
            } else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    initCustomProviderListeners() {
        document.getElementById('addProviderBtn').addEventListener('click', () => this.addCustomProvider());
        document.getElementById('toggleCustomKeyVisibility').addEventListener('click', () => this.toggleKeyVisibility('customProviderApiKey'));
    }

    // ==================== API Key ====================

    initApiKeyListeners() {
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
        this.apiKeyModal.addEventListener('click', (e) => { if (e.target === this.apiKeyModal) this.hideModal(); });
        document.getElementById('apiKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveApiKey(); });
        document.getElementById('modalApiKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveApiKeyFromModal(); });

        // 智能索引（RAG）设置
        document.getElementById('embedProviderSelect').addEventListener('change', () => this.updateEmbedConfigVisibility());
        document.getElementById('saveEmbedSettingsBtn').addEventListener('click', () => this.saveEmbeddingSettings());
        document.getElementById('deleteEmbedKeyBtn').addEventListener('click', () => this.deleteEmbedAliyunKey());
    }

    // ==================== Embedding (RAG) Settings ====================

    updateEmbedConfigVisibility() {
        const provider = document.getElementById('embedProviderSelect').value;
        // auto 也可能用到阿里云，展示配置区便于填写
        document.getElementById('embedAliyunConfig').style.display =
            (provider === 'aliyun' || provider === 'auto') ? 'block' : 'none';
    }

    async loadEmbeddingSettings() {
        try {
            const res = await this.apiFetch('/api/embedding-settings');
            if (!res.ok) return;
            const data = await res.json();
            this.embedSettings = data;
            document.getElementById('embedProviderSelect').value = data.provider || 'auto';
            document.getElementById('embedAliyunBaseUrl').value = data.aliyun.baseUrl || '';
            document.getElementById('embedAliyunModel').value = data.aliyun.model || '';
            const keyStatus = document.getElementById('embedAliyunKeyStatus');
            keyStatus.textContent = data.aliyun.hasKey ? `（已配置 ${data.aliyun.maskedKey || ''}，留空则不修改）` : '';
            document.getElementById('deleteEmbedKeyBtn').style.display = data.aliyun.maskedKey ? 'inline-flex' : 'none';
            const hint = document.getElementById('embedActiveHint');
            if (!data.vectorAvailable) {
                hint.textContent = '⚠️ 服务端向量扩展不可用，当前仅支持 BM25 检索';
            } else if (data.provider === 'off') {
                hint.textContent = '已关闭向量化，建索引时仅使用 BM25 关键词检索';
            } else if (data.active) {
                hint.textContent = `✅ 当前生效：${data.active.providerName} · ${data.active.model}`;
            } else {
                hint.textContent = '⚠️ 暂无可用的向量化提供商（未配置密钥），建索引时将使用 BM25。';
            }
            this.updateEmbedConfigVisibility();
        } catch {}
    }

    async saveEmbeddingSettings() {
        const btn = document.getElementById('saveEmbedSettingsBtn');
        const provider = document.getElementById('embedProviderSelect').value;
        const aliyunBaseUrl = document.getElementById('embedAliyunBaseUrl').value.trim();
        const aliyunModel = document.getElementById('embedAliyunModel').value.trim();
        const aliyunApiKey = document.getElementById('embedAliyunKey').value.trim();
        if (provider === 'aliyun' && (!aliyunBaseUrl || !aliyunModel)) {
            this.showToast('请填写阿里云接口地址和模型名称');
            return;
        }
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const body = { provider, aliyunBaseUrl, aliyunModel };
            if (aliyunApiKey) body.aliyunApiKey = aliyunApiKey;
            const res = await this.apiFetch('/api/embedding-settings', { method: 'PUT', body: JSON.stringify(body) });
            const data = await res.json();
            if (res.ok) {
                this.showToast(data.active ? `设置已保存，当前生效：${data.active.providerName}` : '设置已保存（当前无可用向量化，将使用 BM25）');
                document.getElementById('embedAliyunKey').value = '';
                this.loadEmbeddingSettings();
            } else {
                this.showToast(data.error || '保存失败');
            }
        } catch { this.showToast('保存失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async deleteEmbedAliyunKey() {
        if (!confirm('确定删除阿里云 Embedding 密钥吗？删除后相关书籍检索将降级为 BM25。')) return;
        try {
            const res = await this.apiFetch('/api/embedding-settings/aliyun-key', { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { this.showToast('密钥已删除'); this.loadEmbeddingSettings(); }
            else this.showToast(data.error || '删除失败');
        } catch { this.showToast('删除失败'); }
    }

    async checkApiKeyStatus() {
        const keyStatusValue = document.getElementById('keyStatusValue');
        if (keyStatusValue) { keyStatusValue.textContent = '检查中...'; keyStatusValue.className = 'status-value'; }
        try {
            const response = await this.apiFetch('/api/key/status');
            const data = await response.json();
            this.apiProviders = data.providers || {};
            const providerData = this.apiProviders[this.currentProvider] || {};
            if (providerData.hasKey) {
                if (keyStatusValue) { keyStatusValue.textContent = '已配置'; keyStatusValue.className = 'status-value connected'; }
                document.getElementById('maskedKeyRow').style.display = 'flex';
                document.getElementById('maskedKeyValue').textContent = providerData.maskedKey;
                if (providerData.lastUpdated) { document.getElementById('lastUpdatedRow').style.display = 'flex'; document.getElementById('lastUpdatedValue').textContent = new Date(providerData.lastUpdated).toLocaleString('zh-CN'); }
                document.getElementById('deleteApiKeyBtn').style.display = 'inline-flex';
                const pi = this.providers.find(p => p.id === this.currentProvider);
                if (pi) { document.getElementById('modelRow').style.display = 'flex'; document.getElementById('modelValue').textContent = this.currentModel || pi.defaultModel; }
            } else {
                if (keyStatusValue) { keyStatusValue.textContent = '未配置'; keyStatusValue.className = 'status-value disconnected'; }
                document.getElementById('maskedKeyRow').style.display = 'none';
                document.getElementById('lastUpdatedRow').style.display = 'none';
                document.getElementById('deleteApiKeyBtn').style.display = 'none';
                document.getElementById('modelRow').style.display = 'none';
            }
        } catch {
            if (keyStatusValue) { keyStatusValue.textContent = '检查失败'; keyStatusValue.className = 'status-value disconnected'; }
        }
    }

    toggleKeyVisibility(inputId) { const i = document.getElementById(inputId); i.type = i.type === 'password' ? 'text' : 'password'; }

    async saveApiKey() {
        const input = document.getElementById('apiKeyInput');
        const apiKey = input.value.trim();
        if (!apiKey) { this.showToast('请输入API密钥'); return; }
        const btn = document.getElementById('saveApiKeyBtn');
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const response = await this.apiFetch('/api/key/set', { method: 'POST', body: JSON.stringify({ apiKey, provider: this.currentProvider }) });
            const data = await response.json();
            if (response.ok) { this.showToast('API密钥保存成功！'); input.value = ''; this.checkApiKeyStatus(); }
            else { this.showToast(data.error || '保存失败'); }
        } catch { this.showToast('保存失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async verifyApiKey() {
        const btn = document.getElementById('verifyApiKeyBtn');
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const response = await this.apiFetch('/api/key/verify', { method: 'POST', body: JSON.stringify({ provider: this.currentProvider }) });
            const data = await response.json();
            this.showToast(data.valid ? '验证成功！' : (data.error || '密钥无效'));
        } catch { this.showToast('验证失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async deleteApiKey() {
        const pi = this.providers.find(p => p.id === this.currentProvider);
        if (!confirm(`确定删除${pi ? pi.name : ''}API密钥吗？`)) return;
        try {
            const response = await this.apiFetch('/api/key', { method: 'DELETE', body: JSON.stringify({ provider: this.currentProvider }) });
            const data = await response.json();
            if (data.success) { this.showToast('密钥已删除'); this.checkApiKeyStatus(); }
            else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    async saveApiKeyFromModal() {
        const input = document.getElementById('modalApiKeyInput');
        const apiKey = input.value.trim();
        if (!apiKey) { this.showToast('请输入API密钥'); return; }
        const btn = document.getElementById('modalSaveBtn');
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const response = await this.apiFetch('/api/key/set', { method: 'POST', body: JSON.stringify({ apiKey, provider: this.currentProvider }) });
            if (response.ok) { this.showToast('API配置成功！'); this.hideModal(); this.checkApiKeyStatus(); }
            else { const d = await response.json(); this.showToast(d.error || '配置失败'); }
        } catch { this.showToast('配置失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    showModal() { this.apiKeyModal.classList.add('visible'); document.getElementById('modalApiKeyInput').focus(); }
    hideModal() { this.apiKeyModal.classList.remove('visible'); document.getElementById('modalApiKeyInput').value = ''; }

    // ==================== History ====================

    async saveToHistory(selectedText, question, answer) {
        const item = { id: Date.now(), text: (selectedText || '').substring(0, 100) + ((selectedText || '').length > 100 ? '...' : ''), question, answer, time: new Date().toLocaleString('zh-CN') };
        this.history.unshift(item);
        if (this.history.length > 50) this.history = this.history.slice(0, 50);
        try { await this.apiFetch('/api/history', { method: 'POST', body: JSON.stringify({ text: selectedText, question, answer }) }); } catch {}
    }

    async loadHistory() {
        this.historyList.innerHTML = '<p class="empty-history">加载中...</p>';
        try {
            if (!this.books || !this.books.length) {
                const bres = await this.apiFetch('/api/books');
                const bd = await bres.json();
                this.books = bd.books || [];
            }
            const res = await this.apiFetch('/api/conversations');
            const data = await res.json();
            this.renderConversations(data.conversations || []);
        } catch { this.historyList.innerHTML = '<p class="empty-history">加载失败</p>'; }
    }

    renderConversations(list) {
        if (!list.length) { this.historyList.innerHTML = '<p class="empty-history">暂无对话历史，去阅读页面和 AI 聊聊吧</p>'; return; }
        this.historyList.innerHTML = list.map(c => {
            const book = this.books.find(b => b.id === c.bookId);
            const bookName = book ? book.title : '自由对话';
            const time = c.updatedAt ? new Date(c.updatedAt).toLocaleString('zh-CN') : '';
            return `<div class="conv-item" data-conv-id="${c.id}" data-book-id="${c.bookId || ''}">
                <div class="conv-item-main">
                    <div class="conv-item-title">${this.escapeHtml(c.title || '新对话')}</div>
                    <div class="conv-item-meta">
                        <span class="conv-item-book">📖 ${this.escapeHtml(bookName)}</span>
                        <span class="conv-item-tokens">${this.formatTokens(c.tokenEstimate || 0)} tokens</span>
                        <span class="conv-item-time">${time}</span>
                    </div>
                </div>
                <button class="conv-item-del" data-conv-id="${c.id}" title="删除该对话">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>`;
        }).join('');
        this.historyList.querySelectorAll('.conv-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.conv-item-del')) return;
                this.openConversationFromHistory(el.dataset.convId, el.dataset.bookId || null);
            });
        });
        this.historyList.querySelectorAll('.conv-item-del').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteConversationFromHistory(btn.dataset.convId); });
        });
    }

    async openConversationFromHistory(convId, bookId) {
        this._openingConv = true; // 抑制 enterReadingMode 里自动加载 active 会话，避免竞态
        try {
            if (bookId) {
                await this.openBook(bookId);
                if (!this.currentBook || this.currentBook.id !== bookId) { this.showToast('无法打开对应书籍'); return; }
            }
            this.currentConversationId = convId;
            this._chatLoadedConvId = null;
            await this.openAIPanel();
        } finally {
            this._openingConv = false;
        }
    }

    async deleteConversationFromHistory(convId) {
        if (!confirm('确定删除这段对话吗？删除后不可恢复。')) return;
        try {
            const res = await this.apiFetch(`/api/conversations/${convId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                this.showToast('对话已删除');
                if (this.currentConversationId === convId) { this.currentConversationId = null; this._chatLoadedConvId = null; }
                this.loadHistory();
            } else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    // ==================== Keyboard ====================

    handleKeyboardShortcuts(e) {
        if (e.ctrlKey && e.key === 'Enter' && document.getElementById('aiChatView').classList.contains('open')) this.handleAskQuestion();
        if (e.key === 'Escape') {
            this.closeAIPanel();
            this.hideFloatingToolbar();
            this.hideModal();
            this.closeTocDrawer();
            if (this.isReading && this.toolbarsVisible) this.hideToolbars();
        }
    }

    // ==================== Utils ====================

    showToast(message) {
        this.toast.textContent = message;
        this.toast.classList.add('show');
        setTimeout(() => this.toast.classList.remove('show'), 3000);
    }

    getCurrentBookName() {
        if (this.currentBook) return this.currentBook.title;
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
