class AIReadingAssistant {
    constructor() {
        this.selectedText = '';
        this.history = [];
        this.currentFontSize = parseInt(localStorage.getItem('fontSize')) || 18;
        this.currentTheme = localStorage.getItem('theme') || 'light';
        this.readerFont = localStorage.getItem('readerFont') || 'serif';
        this.apiProviders = {};
        this.currentProvider = localStorage.getItem('selectedProvider') || 'custom';
        this.currentModel = localStorage.getItem(`selectedModel_${this.currentProvider}`) || null;
        this.books = [];
        this.providers = [];
        this.currentBook = null;
        this.currentBookContent = null;
        this.isReading = false;
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
            const sideAvatar = document.getElementById('sideAvatar');
            if (sideAvatar) sideAvatar.textContent = this.currentUser.username.charAt(0).toUpperCase();
            const myUsername = document.getElementById('myUsername');
            if (myUsername) myUsername.textContent = this.currentUser.username;
            const myAvatar = document.getElementById('myAvatar');
            if (myAvatar) myAvatar.textContent = this.currentUser.username.charAt(0).toUpperCase();
        }
        this.initEventListenersOnce();
        this.loadProviders();
        this.checkApiKeyStatus();
        this.loadHistory();
        this.loadBooks();
        // Apply saved font size
        document.getElementById('fontSizeDisplay').textContent = `${this.currentFontSize}px`;
        document.getElementById('readFontSizeDisplay').textContent = `${this.currentFontSize}px`;
    }

    // 退出后重新登录会再次进入 initApp：事件只绑定一次，避免重复触发
    initEventListenersOnce() {
        if (this._listenersBound) return;
        this._listenersBound = true;
        this.initEventListeners();
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
        this.providerModal = document.getElementById('providerModal');
        this.providerList = document.getElementById('providerList');
        this.agentTaskModal = document.getElementById('agentTaskModal');
    }

    // ==================== Event Listeners ====================

    initEventListeners() {
        // 主导航（桌面侧边栏 + 窄窗口底部导航）
        document.querySelectorAll('.bottom-nav-item, .side-nav-item').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e.currentTarget.dataset.view));
        });

        // 设置子页导航
        document.getElementById('settingsNav').addEventListener('click', (e) => {
            const btn = e.target.closest('.settings-nav-item');
            if (btn) this.switchSettingsPage(btn.dataset.sp);
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

        this.askBtn.addEventListener('click', () => { if (this._asking) this.stopGeneration(); else this.handleAskQuestion(); });
        this.questionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleAskQuestion(); }
        });
        this.questionInput.addEventListener('input', () => this.autoGrowInput());
        document.getElementById('chatBackBtn').addEventListener('click', () => this.closeAIPanel());
        const clearCtxBtn = document.getElementById('clearSelectedTextBtn');
        if (clearCtxBtn) clearCtxBtn.addEventListener('click', () => this.clearComposerContext());

        // 统一问答入口（P1a）：不再需要 Agent 模式开关，由服务端自动决策工具

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
        const memoryToggle = document.getElementById('memoryEnabledToggle');
        if (memoryToggle) memoryToggle.addEventListener('change', () => this.toggleMemoryEnabled(memoryToggle.checked));

        // Agent task modal
        const taskCloseBtn = document.getElementById('agentTaskCloseBtn');
        const taskCancelBtn = document.getElementById('agentTaskCancelBtn');
        if (taskCloseBtn) taskCloseBtn.addEventListener('click', () => this.closeTaskModal());
        if (taskCancelBtn) taskCancelBtn.addEventListener('click', () => this.closeTaskModal());

        // Notes modal：运行中关闭 = 转后台运行
        document.getElementById('notesCloseBtn').addEventListener('click', () => this.closeNotesModal());
        document.getElementById('notesFooterBtn').addEventListener('click', () => this.closeNotesModal());
        document.getElementById('notesModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) this.closeNotesModal(); });

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

        // 正文字体（衬线/无衬线）
        document.querySelectorAll('.reader-font-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.setReaderFont(e.currentTarget.dataset.readerFont));
        });
        this.syncReaderFontButtons();

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

        // Provider card & modal listeners
        this.initProviderListeners();

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
    }

    // ==================== View Switching ====================

    switchView(view) {
        document.getElementById('bookshelfView').classList.toggle('active', view === 'bookshelf');
        document.getElementById('historyView').classList.toggle('active', view === 'history');
        document.getElementById('settingsView').classList.toggle('active', view === 'settings');

        document.querySelectorAll('.bottom-nav-item, .side-nav-item').forEach(btn => {
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

    switchSettingsPage(name) {
        document.querySelectorAll('.settings-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.sp === name);
        });
        document.querySelectorAll('.settings-page').forEach(page => {
            page.classList.toggle('active', page.id === `sp-${name}`);
        });
        if (name === 'models') this.checkApiKeyStatus();
        if (name === 'rag') this.loadEmbeddingSettings();
        if (name === 'rerank') this.loadRerankSettings();
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
        const bookFileInput = document.getElementById('bookFileInput');
        const uploadBookBtn = document.getElementById('uploadBookBtn');
        const booksGrid = document.getElementById('booksGrid');

        uploadBookBtn.addEventListener('click', () => bookFileInput.click());
        bookFileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) this.uploadBook(e.target.files[0]); });

        // 上传卡片在网格内动态渲染，用事件委托
        booksGrid.addEventListener('click', (e) => {
            if (e.target.closest('.upload-card')) bookFileInput.click();
        });
        booksGrid.addEventListener('dragover', (e) => {
            if (!e.target.closest('.upload-card')) return;
            e.preventDefault();
            e.target.closest('.upload-card').classList.add('dragover');
        });
        booksGrid.addEventListener('dragleave', (e) => {
            const card = e.target.closest('.upload-card');
            if (card && !card.contains(e.relatedTarget)) card.classList.remove('dragover');
        });
        booksGrid.addEventListener('drop', (e) => {
            const card = e.target.closest('.upload-card');
            if (!card) return;
            e.preventDefault();
            card.classList.remove('dragover');
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
        libraryStats.innerHTML = `共 <strong>${this.books.length}</strong> 本书`;

        const uploadTile = `
            <div class="upload-card" id="uploadCard" role="button" tabindex="0" title="上传新书籍">
                <svg class="upload-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <span class="upload-card-title">上传新书籍</span>
                <span class="upload-card-hint">TXT / PDF / EPUB / MOBI<br>点击选择或拖入文件</span>
            </div>`;

        if (this.books.length === 0) {
            booksGrid.innerHTML = uploadTile + `<div class="empty-library"><svg class="empty-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><p>书架空空如也</p><p class="empty-hint">上传你的第一本书开始阅读吧</p></div>`;
            return;
        }

        const covers = ['#1e5b45', '#c2401f', '#3b4a6b', '#b45309', '#2a7d7b', '#7d3a5c', '#6b7a2a', '#4a5568'];
        const hashOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

        booksGrid.innerHTML = uploadTile + this.books.map((book, i) => {
            const progress = book.readProgress || book.read_progress || 0;
            const color = covers[hashOf(book.title || book.id) % covers.length];
            const pct = Math.round(progress * 100);
            const isTxt = book.format.toLowerCase() === 'txt';
            const notesRunning = this._notesRunningFor === book.id;
            return `
                <div class="book-card" data-book-id="${this.escapeHtml(book.id)}" style="--i:${Math.min(i, 12)}">
                    <div class="book-cover" style="--cover:${color}">
                        <span class="cover-format">${this.escapeHtml(book.format)}</span>
                        <span class="cover-title">${this.escapeHtml(book.title)}</span>
                        <span class="cover-seal">读</span>
                        ${pct > 0 ? `<span class="cover-progress"><i style="width:${pct}%"></i></span>` : ''}
                        <div class="book-hover">
                            <button class="book-action-btn read-btn">开始阅读</button>
                            <div class="book-hover-row">
                                ${isTxt ? `<button class="book-action-btn index-btn">AI索引</button><button class="book-action-btn notes-btn${notesRunning ? ' is-running' : ''}">${notesRunning ? '生成中…' : '笔记'}</button>` : ''}
                                <button class="book-action-btn delete-btn">删除</button>
                            </div>
                        </div>
                    </div>
                    <div class="book-meta">
                        <div class="book-title" title="${this.escapeHtml(book.title)}">${this.escapeHtml(book.title)}</div>
                        <div class="book-progress">${pct > 0 ? `已读 ${pct}%` : '未读'}</div>
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
            if (notesBtn) notesBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openNotesModal(bookId); });
            card.addEventListener('click', () => this.openBook(bookId));
        });
    }

    async openBook(bookId) {
        try {
            const response = await this.apiFetch(`/api/books/${bookId}`);
            const data = await response.json();
            if (!response.ok) { this.showToast(data.error || '打开失败'); return; }
            const book = data.book;
            if (book.format.toLowerCase() === 'txt' && data.content != null) {
                this.enterReadingMode(book, data.content, data.contentHash || null, data.chapters || []);
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

    enterReadingMode(book, content, contentHash = null, chapters = []) {
        this.currentBook = book;
        this.isReading = true;
        this.currentBookContent = content;
        this.currentBookHash = contentHash;
        this.currentChapters = chapters;
        this._readerMap = [];
        this._highlightedBlocks = [];

        // Reset conversation state on book switch (per-book session isolation)
        this.currentConversationId = null;
        this.currentContextTokens = 0;
        this._chatLoadedConvId = null;
        this.updateSessionInfo(0);
        this.loadActiveConversation(book ? book.id : null);

        // Set title
        document.getElementById('readingBookTitle').textContent = book.title;

        // Format and display content (规范文本 + 偏移映射)
        const article = document.getElementById('readingArticle');
        this.renderReadingContent(article, content, chapters);
        article.style.fontSize = `${this.currentFontSize}px`;
        article.classList.toggle('reader-sans', this.readerFont === 'sans');

        // Update TOC
        this.updateReadingTOC();

        // Show reading view, hide app chrome
        document.getElementById('readingView').classList.add('active');
        document.body.classList.add('reading-active');
        document.getElementById('bottomNav').classList.add('hidden');
        document.getElementById('appHeader').style.display = 'none';

        // 桌面端默认展示工具栏；窄窗口点击正文唤出
        const desktop = window.matchMedia('(min-width: 1024px)').matches;
        this.toolbarsVisible = desktop;
        document.getElementById('readingToolbarTop').classList.toggle('hidden', !desktop);
        document.getElementById('readingToolbarBottom').classList.toggle('hidden', !desktop);
        document.getElementById('aiFab').classList.toggle('hidden', desktop);

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
        document.getElementById('readingView').classList.remove('chat-open');
        document.body.classList.remove('reading-active');
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

    // ==================== Content Formatting (规范文本 + 偏移映射) ====================

    /**
     * 按服务端章节渲染规范文本：每个渲染块保留 data-start/end，块内用 createTextNode，
     * white-space:pre-wrap 保留换行与空白；建立 TextNode→规范偏移映射供选文与引用跳转。
     */
    renderReadingContent(article, content, chapters) {
        article.innerHTML = '';
        this._readerMap = [];
        const chs = (chapters && chapters.length) ? chapters : [{ id: 'ch-1-0', ordinal: 1, title: '全文', start: 0, end: content.length }];
        chs.forEach((ch, i) => {
            const section = document.createElement('section');
            section.className = 'content-section';
            section.id = `section${i + 1}`;
            section.dataset.chapterId = ch.id;
            // 判断章节首行是否为真实标题行（合成标签“前言/全文”不作为原文标题）
            const firstNl = content.indexOf('\n', ch.start);
            const firstLineEnd = (firstNl === -1 || firstNl > ch.end) ? ch.end : firstNl;
            const firstLine = content.slice(ch.start, firstLineEnd);
            const isRealTitle = firstLine.trim() === ch.title && ch.title !== '前言' && ch.title !== '全文';
            let bodyStart = ch.start;
            const h2 = document.createElement('h2');
            if (isRealTitle) {
                h2.className = 'reader-block reader-title';
                h2.dataset.start = ch.start;
                h2.dataset.end = firstLineEnd;
                const tn = document.createTextNode(firstLine);
                h2.appendChild(tn);
                this._readerMap.push({ node: tn, start: ch.start, end: firstLineEnd, block: h2 });
                bodyStart = Math.min(firstLineEnd + 1, ch.end);
            } else {
                h2.className = 'reader-title reader-title-synthetic';
                h2.textContent = ch.title; // 结构标签，不参与偏移映射
            }
            section.appendChild(h2);
            if (bodyStart < ch.end) {
                const p = document.createElement('p');
                p.className = 'reader-block reader-body';
                p.dataset.start = bodyStart;
                p.dataset.end = ch.end;
                const tn = document.createTextNode(content.slice(bodyStart, ch.end));
                p.appendChild(tn);
                this._readerMap.push({ node: tn, start: bodyStart, end: ch.end, block: p });
                section.appendChild(p);
            }
            article.appendChild(section);
        });
    }

    /** 由 DOM 节点+偏移计算规范文本全局偏移；无法映射返回 null */
    _globalOffset(container, offset) {
        if (!container) return null;
        if (container.nodeType === 3) {
            const entry = this._readerMap.find(m => m.node === container);
            if (!entry) return null;
            return entry.start + Math.min(offset, entry.end - entry.start);
        }
        // 元素节点：定位到对应子文本节点
        const children = container.childNodes;
        if (offset < children.length) {
            let n = children[offset];
            while (n && n.nodeType !== 3 && n.firstChild) n = n.firstChild;
            if (n && n.nodeType === 3) return this._globalOffset(n, 0);
        } else if (children.length) {
            let n = children[children.length - 1];
            while (n && n.nodeType !== 3 && n.lastChild) n = n.lastChild;
            if (n && n.nodeType === 3) return this._globalOffset(n, n.length);
        }
        return null;
    }

    /** 从当前选区计算规范 locator；跨出正文或无法映射时返回 null */
    computeSelectionLocator() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !this.currentBookContent) return null;
        const range = selection.getRangeAt(0);
        const article = document.getElementById('readingArticle');
        if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
        const s = this._globalOffset(range.startContainer, range.startOffset);
        const e = this._globalOffset(range.endContainer, range.endOffset);
        if (s == null || e == null || s >= e) return null;
        const start = Math.min(s, e), end = Math.max(s, e);
        return { contentHash: this.currentBookHash, start, end, text: this.currentBookContent.slice(start, end) };
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

    setReaderFont(font) {
        if (!font) return;
        this.readerFont = font;
        localStorage.setItem('readerFont', font);
        const article = document.getElementById('readingArticle');
        if (article) article.classList.toggle('reader-sans', font === 'sans');
        this.syncReaderFontButtons();
    }

    syncReaderFontButtons() {
        document.querySelectorAll('.reader-font-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.readerFont === this.readerFont);
        });
    }

    // ==================== AI Panel ====================

    toggleAIPanel() {
        const view = document.getElementById('aiChatView');
        if (view.classList.contains('open')) this.closeAIPanel();
        else this.openAIPanel();
    }

    closeAIPanel() {
        document.getElementById('aiChatView').classList.remove('open');
        document.getElementById('readingView').classList.remove('chat-open');
        document.getElementById('aiFab').classList.toggle('hidden', this.toolbarsVisible);
    }

    async openAIPanel() {
        const view = document.getElementById('aiChatView');
        view.classList.add('open');
        document.getElementById('readingView').classList.add('chat-open');
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
        this.selectedLocator = null;
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
        const thinking = document.createElement('div');
        thinking.className = 'msg-thinking';
        const thinkingToggle = document.createElement('button');
        thinkingToggle.type = 'button';
        thinkingToggle.className = 'thinking-toggle';
        thinkingToggle.innerHTML = '💭 <span class="thinking-label">思考过程</span><span class="thinking-chevron">▸</span>';
        const thinkingBody = document.createElement('div');
        thinkingBody.className = 'thinking-body';
        thinkingBody.hidden = true;
        thinkingToggle.addEventListener('click', () => {
            thinkingBody.hidden = !thinkingBody.hidden;
            thinkingToggle.querySelector('.thinking-chevron').textContent = thinkingBody.hidden ? '▸' : '▾';
        });
        thinking.appendChild(thinkingToggle);
        thinking.appendChild(thinkingBody);
        const trace = document.createElement('div');
        trace.className = 'msg-trace';
        const evidenceBox = document.createElement('div');
        evidenceBox.className = 'msg-evidence';
        const memoryBox = document.createElement('div');
        memoryBox.className = 'msg-memory';
        const answer = document.createElement('div');
        answer.className = 'answer-content';
        answer.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
        body.appendChild(header);
        body.appendChild(thinking);
        body.appendChild(trace);
        body.appendChild(evidenceBox);
        body.appendChild(memoryBox);
        body.appendChild(answer);
        row.appendChild(avatar);
        row.appendChild(body);
        this.chatMessages.appendChild(row);
        this.scrollChatToBottom();
        return { row, headerEl: header, thinkingEl: thinking, thinkingBodyEl: thinkingBody, thinkingLabelEl: thinkingToggle.querySelector('.thinking-label'), traceEl: trace, evidenceEl: evidenceBox, memoryEl: memoryBox, answerEl: answer };
    }

    appendThinking(msg, text) {
        msg.thinkingEl.classList.add('show');
        msg.thinkingBodyEl.textContent += text;
        msg.thinkingLabelEl.textContent = '思考中…';
    }

    finalizeThinking(msg) {
        if (msg.thinkingEl.classList.contains('show')) msg.thinkingLabelEl.textContent = '思考过程';
    }

    renderStaticMessage(role, content, metadata = null, memoryMap = null) {
        if (role === 'user') {
            const quoted = metadata && metadata.selection && metadata.selection.text ? metadata.selection.text : null;
            this.appendUserMessage(content, quoted);
            return;
        }
        this.hideChatEmpty();
        const msg = this.createAIMessage();
        msg.answerEl.innerHTML = '';
        let emap = {};
        if (metadata && Array.isArray(metadata.evidence)) emap = this.renderEvidenceCards(msg.evidenceEl, metadata.evidence);
        if (metadata && Array.isArray(metadata.memoryRefs) && metadata.memoryRefs.length) {
            this.renderMemoryRefs(msg.memoryEl, metadata.memoryRefs, memoryMap);
        }
        this.renderAnswerWithCitations(msg.answerEl, content, emap, true);
        if (metadata && metadata.reasoning) {
            msg.thinkingBodyEl.textContent = metadata.reasoning;
            msg.thinkingEl.classList.add('show');
        }
        if (metadata && metadata.answerKind === 'insufficient_evidence') this.appendTraceItem(msg.traceEl, 'fallback', '⚠️ 证据不足，不凭印象作答');
        if (metadata && metadata.answerKind === 'task_result') this.appendTraceItem(msg.traceEl, 'status', '📋 长任务结果（采样分析）');
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
            else {
                // 历史 MemoryRef 只存 ID/版本：重开时查当前记忆，已删/已更新如实显示，不还原旧正文
                let memoryMap = null;
                if (msgs.some(m => m.metadata && Array.isArray(m.metadata.memoryRefs) && m.metadata.memoryRefs.length)) {
                    memoryMap = await this.fetchMemoryMap();
                }
                msgs.forEach(m => this.renderStaticMessage(m.role, m.content, m.metadata, memoryMap));
            }
            this._chatLoadedConvId = convId;
            this.scrollChatToBottom();
        } catch { this.showChatEmpty(); }
    }


    // ==================== Text Selection & AI ====================

    handleTextSelection(e) {
        if (this.floatingToolbar.contains(e.target) || document.getElementById('aiChatView').contains(e.target)) return;
        setTimeout(() => {
            const selection = window.getSelection();
            const rawText = selection ? selection.toString().trim() : '';
            if (rawText.length > 0 && this.isReading) {
                const loc = this.computeSelectionLocator();
                if (loc && loc.text.trim()) {
                    // 可映射：用规范 content.slice 作为选文（不依赖 Range.toString 的布局换行）
                    this.selectedText = loc.text;
                    this.selectedLocator = { contentHash: loc.contentHash, start: loc.start, end: loc.end };
                } else {
                    this.selectedText = rawText;
                    this.selectedLocator = null;
                }
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
        await this.askAI(actionMap[action] || action, action);
    }

    async handleAskQuestion() {
        const question = this.questionInput.value.trim();
        if (!question) { this.showToast('请输入问题'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        await this.askAI(question);
    }

    async askAI(question, action = 'ask') {
        if (!this.providers || !this.providers.some(p => p.isCustom)) {
            this.appendUserMessage(question, this.selectedText || '');
            const msg = this.createAIMessage();
            msg.answerEl.innerHTML = '<p style="color:#ef4444;">请先在设置中添加一个自定义 AI 服务提供商（OpenAI 兼容端点）。</p>';
            return;
        }
        const quoted = this.selectedText || '';
        const quotedLocator = this.selectedLocator || null;
        const requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
        this.setAsking(true);
        this.appendUserMessage(question, quoted);
        this.clearComposerContext();
        this.questionInput.value = '';
        this.autoGrowInput();
        const msg = this.createAIMessage();
        const answerEl = msg.answerEl, traceEl = msg.traceEl, headerEl = msg.headerEl, evidenceEl = msg.evidenceEl;
        this._abortController = new AbortController();
        this._currentRequestId = requestId;

        let fullContent = '', rafId = null, started = false, ended = false;
        let evidenceMap = {};
        const flushChunk = () => {
            this.renderAnswerWithCitations(answerEl, fullContent, evidenceMap, false);
            this.scrollChatToBottom();
        };

        const handleEvt = (evt) => {
            const d = evt.data || {};
            switch (evt.type) {
                case 'start':
                    if (d.conversationId) this.currentConversationId = d.conversationId;
                    headerEl.textContent = `${d.provider} · ${d.model}`;
                    headerEl.classList.add('show');
                    answerEl.innerHTML = ''; started = true;
                    break;
                case 'status':
                    this.appendTraceItem(traceEl, 'status', `⏳ ${d.label || d.phase || ''}`);
                    break;
                case 'reasoning_chunk':
                    this.appendThinking(msg, d.content || '');
                    this.scrollChatToBottom();
                    break;
                case 'answer_retract':
                    // 暂定正文被收回（本轮以工具调用结束/改走证据型答案）：归入思考展示
                    if (fullContent) this.appendThinking(msg, (msg.thinkingBodyEl.textContent ? '\n' : '') + fullContent);
                    fullContent = '';
                    answerEl.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
                    break;
                case 'tool_call':
                    this.appendTraceItem(traceEl, 'tool_call', `🔧 调用工具：${d.name}(${JSON.stringify(d.args)})`);
                    break;
                case 'tool_result': {
                    const failed = d.status === 'error';
                    const em = failed && d.error ? `：${d.error.message}` : '';
                    this.appendTraceItem(traceEl, failed ? 'tool_error' : 'tool_result', `${failed ? '❌' : '✅'} ${d.name}：${d.status} · 返回${d.returnedCount || 0}条${d.truncated ? '(已裁剪)' : ''}${em}（${d.elapsedMs || 0}ms）`);
                    break;
                }
                case 'evidence':
                    evidenceMap = this.renderEvidenceCards(evidenceEl, d.items || []);
                    break;
                case 'memory_context':
                    this.renderMemoryRefs(msg.memoryEl, d.refs || [], null, d.items || []);
                    break;
                case 'warning':
                    this.appendTraceItem(traceEl, 'fallback', `⚠️ ${d.message || ''}`);
                    break;
                case 'task_progress':
                    this.appendTraceItem(traceEl, 'status', `📋 任务进度 ${d.completedUnits || 0}/${d.totalUnits || 0}`);
                    break;
                case 'answer_start':
                    answerEl.innerHTML = ''; started = true;
                    if (d.answerKind === 'insufficient_evidence') this.appendTraceItem(traceEl, 'fallback', '⚠️ 证据不足，不凭印象作答');
                    if (d.answerKind === 'task_result') this.appendTraceItem(traceEl, 'status', '📋 长任务结果（采样分析）');
                    break;
                case 'chunk':
                    if (!started) { answerEl.innerHTML = ''; started = true; }
                    fullContent += d.content || '';
                    if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; flushChunk(); });
                    break;
                case 'end':
                    ended = true;
                    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                    this.finalizeThinking(msg);
                    if (d.status === 'completed' && d.assistantMessage) {
                        // 用服务端规范化后的终态正文校准（引用无效标记一致），并刷新证据卡片
                        fullContent = d.assistantMessage.content != null ? d.assistantMessage.content : fullContent;
                        const meta = d.assistantMessage.metadata;
                        if (meta && Array.isArray(meta.evidence)) evidenceMap = this.renderEvidenceCards(evidenceEl, meta.evidence);
                        if (meta && meta.reasoning && !msg.thinkingBodyEl.textContent) {
                            msg.thinkingBodyEl.textContent = meta.reasoning;
                            msg.thinkingEl.classList.add('show');
                        }
                        if (meta && Array.isArray(meta.memoryRefs) && meta.memoryRefs.length && !msg.memoryEl.childElementCount) {
                            this.renderMemoryRefs(msg.memoryEl, meta.memoryRefs, null);
                        }
                        this.renderAnswerWithCitations(answerEl, fullContent, evidenceMap, true);
                        // 记忆后处理真实状态：pending→轮询请求查询；不宣称"已记住"
                        if (d.postProcessing && d.postProcessing.status === 'pending') {
                            this.pollMemoryPostProcessing(requestId);
                        }
                    } else if (d.status !== 'completed') {
                        const em = (d.error && d.error.message) || d.status;
                        if (!fullContent) answerEl.innerHTML = `<p style="color:#ef4444;">${this.escapeHtml(em)}</p>`;
                        this.appendTraceItem(traceEl, 'fallback', `⚠️ 状态：${d.status}`);
                    }
                    break;
            }
        };

        try {
            const response = await this.apiFetch('/api/ask-stream', {
                method: 'POST',
                signal: this._abortController.signal,
                body: JSON.stringify({
                    requestId, question, action,
                    selection: quoted ? { text: quoted, locator: quotedLocator } : null,
                    provider: this.currentProvider, model: this.currentModel,
                    bookId: this.currentBook ? this.currentBook.id : null,
                    conversationId: this.currentConversationId
                })
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                const err = data.error || {};
                if (response.status === 403 || err.code === 'UNAUTHENTICATED') {
                    answerEl.innerHTML = '<p style="color:#ef4444;">需要配置 AI 服务的 API 密钥</p>';
                    this.checkApiKeyStatus();
                } else {
                    answerEl.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(err.message || '请求失败')}</p>`;
                }
                return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) { if (rafId) cancelAnimationFrame(rafId); flushChunk(); break; }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const s = line.slice(5).trim();
                    if (!s) continue;
                    try { handleEvt(JSON.parse(s)); } catch {}
                }
            }
            buffer += decoder.decode();
            for (const line of buffer.split('\n')) {
                if (line.startsWith('data:')) { const s = line.slice(5).trim(); if (s) { try { handleEvt(JSON.parse(s)); } catch {} } }
            }
            if (!ended) {
                this.appendTraceItem(traceEl, 'fallback', '⚠️ 连接中断，正在核对结果…');
                try {
                    const q = await this.apiFetch(`/api/ask-requests/${requestId}`);
                    if (q.ok) {
                        const qd = await q.json();
                        if (qd.assistantMessage && qd.assistantMessage.content) {
                            const meta = qd.assistantMessage.metadata;
                            const emap = (meta && Array.isArray(meta.evidence)) ? this.renderEvidenceCards(evidenceEl, meta.evidence) : evidenceMap;
                            this.renderAnswerWithCitations(answerEl, qd.assistantMessage.content, emap, true);
                        }
                        this.appendTraceItem(traceEl, 'fallback', `核对状态：${qd.status}`);
                    }
                } catch {}
            }
        } catch (err) {
            if (err.name === 'AbortError') this.appendTraceItem(traceEl, 'fallback', '⏹ 已停止生成');
            else answerEl.innerHTML = '<p style="color:#ef4444;">网络错误</p>';
        } finally {
            this.setAsking(false);
            this._abortController = null;
            this._chatLoadedConvId = this.currentConversationId;
            this.scrollChatToBottom();
        }
    }

    setAsking(loading) {
        this._asking = loading;
        this.askBtn.classList.toggle('loading', loading);
        this.askBtn.disabled = false;
        this.askBtn.title = loading ? '停止生成' : '发送';
        this.questionInput.disabled = loading;
    }

    stopGeneration() {
        if (this._abortController) this._abortController.abort();
    }

    _chapterTitle(ch) {
        if (!ch) return '';
        return typeof ch === 'string' ? ch : (ch.title || '');
    }

    /** 安全渲染回答正文：合法[[En]]→可点击引用，未知/残缺→引用无效，换行→<br>；全部 DOM 文本节点 */
    renderAnswerWithCitations(el, text, evidenceMap, final = false) {
        el.innerHTML = '';
        let src = String(text || '');
        if (final) {
            src = src.replace(/\[\[(?!E\d+\]\])E?\d*\]?/g, '引用无效');
        } else {
            const m = src.match(/\[\[(?!E\d+\]\])E?\d*\]?$/);
            if (m) src = src.slice(0, src.length - m[0].length); // 暂存尾部未闭合标记
        }
        const appendText = (t) => {
            const parts = t.split('\n');
            parts.forEach((part, i) => {
                if (part) el.appendChild(document.createTextNode(part));
                if (i < parts.length - 1) el.appendChild(document.createElement('br'));
            });
        };
        const re = /\[\[(E\d+)\]\]/g;
        let last = 0, m;
        while ((m = re.exec(src)) !== null) {
            appendText(src.slice(last, m.index));
            const id = m[1];
            if (evidenceMap && evidenceMap[id]) {
                const btn = document.createElement('button');
                btn.className = 'citation-btn';
                btn.type = 'button';
                btn.textContent = id;
                btn.title = '跳转到原文';
                btn.addEventListener('click', () => this.jumpToEvidence(evidenceMap[id]));
                el.appendChild(btn);
            } else {
                const span = document.createElement('span');
                span.className = 'citation-invalid';
                span.textContent = '引用无效';
                el.appendChild(span);
            }
            last = re.lastIndex;
        }
        appendText(src.slice(last));
    }

    /** 证据卡片：章节标注 + 预览 + 跳转/不可跳转；返回 evidenceId→evidence 映射 */
    renderEvidenceCards(container, items) {
        if (!container) return {};
        container.innerHTML = '';
        const map = {};
        if (!items || !items.length) return map;
        items.forEach(e => { map[e.evidenceId] = e; });
        const wrap = document.createElement('div');
        wrap.className = 'evidence-cards';
        const title = document.createElement('div');
        title.className = 'evidence-cards-title';
        title.textContent = `📎 本轮证据 ${items.length} 条`;
        wrap.appendChild(title);
        items.forEach(e => {
            const card = document.createElement('div');
            card.className = 'evidence-card';
            const head = document.createElement('div');
            head.className = 'evidence-card-head';
            const idTag = document.createElement('span');
            idTag.className = 'evidence-id';
            idTag.textContent = e.evidenceId;
            head.appendChild(idTag);
            const chTitle = this._chapterTitle(e.chapter);
            if (chTitle) {
                const ch = document.createElement('span');
                ch.className = 'evidence-chapter';
                ch.textContent = chTitle;
                head.appendChild(ch);
            }
            if (e.verified && e.locator) {
                const btn = document.createElement('button');
                btn.className = 'evidence-jump-btn';
                btn.type = 'button';
                btn.textContent = '跳转原文';
                btn.addEventListener('click', () => this.jumpToEvidence(e));
                head.appendChild(btn);
            } else {
                const tag = document.createElement('span');
                tag.className = 'evidence-nojump';
                tag.textContent = '不可跳转';
                head.appendChild(tag);
            }
            card.appendChild(head);
            const preview = document.createElement('div');
            preview.className = 'evidence-preview';
            const t = e.text || '';
            preview.textContent = t.substring(0, 80) + (t.length > 80 ? '…' : '');
            card.appendChild(preview);
            wrap.appendChild(card);
        });
        container.appendChild(wrap);
        return map;
    }

    /** 点击引用跳转：复核权限/内容hash → 高亮相交块 → 滚动 → 返回对话 */
    async jumpToEvidence(evidence) {
        if (!evidence || !evidence.locator || !evidence.verified) { this.showToast('该引用不可跳转'); return; }
        const loc = evidence.locator;
        const bookId = evidence.bookId;
        try {
            // 每次跳转复核权限与当前内容hash（轻量元信息，不整书下载）
            const metaResp = await this.apiFetch(`/api/books/${bookId}/content-meta`);
            if (!metaResp.ok) { this.showToast(metaResp.status === 404 ? '来源不可用（书籍已删除或无权访问）' : '无法加载原文'); return; }
            const meta = await metaResp.json();
            if (meta.contentHash !== loc.contentHash) { this.showToast('原文已变化，无法准确定位'); return; }
            // 当前已加载同书同hash → 用缓存原文；否则加载该书
            if (!this.currentBook || this.currentBook.id !== bookId || this.currentBookHash !== meta.contentHash) {
                const resp = await this.apiFetch(`/api/books/${bookId}`);
                if (!resp.ok) { this.showToast('无法加载原文'); return; }
                const data = await resp.json();
                if (data.contentHash !== loc.contentHash) { this.showToast('原文已变化，无法准确定位'); return; }
                this.enterReadingMode(data.book, data.content, data.contentHash, data.chapters || []);
            }
            this._restoreHighlight();
            const marks = this._highlightRange(loc.start, loc.end);
            if (!marks.length) { this.showToast('未能定位到原文片段'); return; }
            // 窄窗口全屏对话盖住阅读器时先收起；桌面停靠面板保持打开
            if (window.innerWidth < 1024 && document.getElementById('aiChatView').classList.contains('open')) this.closeAIPanel();
            marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            this._showReturnChatBtn();
        } catch { this.showToast('跳转失败'); }
    }

    _highlightRange(start, end) {
        const marks = [];
        const entries = this._readerMap.filter(m => m.start < end && m.end > start);
        for (const entry of entries) {
            const block = entry.block;
            const bs = entry.start, be = entry.end;
            const ls = Math.max(start, bs) - bs;
            const le = Math.min(end, be) - bs;
            const full = this.currentBookContent.slice(bs, be);
            const before = full.slice(0, ls), mid = full.slice(ls, le), after = full.slice(le);
            block.innerHTML = '';
            const newEntries = [];
            if (before) { const tn = document.createTextNode(before); block.appendChild(tn); newEntries.push({ node: tn, start: bs, end: bs + ls, block }); }
            const mark = document.createElement('mark');
            mark.className = 'citation-highlight';
            const mtn = document.createTextNode(mid);
            mark.appendChild(mtn);
            block.appendChild(mark);
            newEntries.push({ node: mtn, start: bs + ls, end: bs + le, block });
            marks.push(mark);
            if (after) { const tn = document.createTextNode(after); block.appendChild(tn); newEntries.push({ node: tn, start: bs + le, end: be, block }); }
            this._readerMap = this._readerMap.filter(m => m !== entry);
            this._readerMap.push(...newEntries);
            if (!this._highlightedBlocks.includes(block)) this._highlightedBlocks.push(block);
        }
        return marks;
    }

    _restoreHighlight() {
        if (!this._highlightedBlocks || !this._highlightedBlocks.length) return;
        for (const block of this._highlightedBlocks) {
            const bs = Number(block.dataset.start), be = Number(block.dataset.end);
            if (!Number.isInteger(bs) || !Number.isInteger(be)) continue;
            block.innerHTML = '';
            const tn = document.createTextNode(this.currentBookContent.slice(bs, be));
            block.appendChild(tn);
            this._readerMap = this._readerMap.filter(m => m.block !== block);
            this._readerMap.push({ node: tn, start: bs, end: be, block });
        }
        this._highlightedBlocks = [];
    }

    _showReturnChatBtn() {
        let btn = document.getElementById('returnChatBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'returnChatBtn';
            btn.className = 'return-chat-btn';
            btn.type = 'button';
            btn.textContent = '↩ 返回对话';
            btn.addEventListener('click', () => { btn.classList.remove('visible'); this.openAIPanel(); });
            document.getElementById('readingView').appendChild(btn);
        }
        btn.classList.add('visible');
    }
    appendTraceItem(traceEl, cls, text, iteration) {
        if (!traceEl) return;
        traceEl.classList.add('show');
        const item = document.createElement('div');
        item.className = `trace-item trace-${cls}`;
        // 先转义再把换行转 <br>，支持多行展示（如检索命中列表）
        item.innerHTML = `<span class="trace-iter">${iteration ? `#${iteration} ` : ''}</span>${this.escapeHtml(text).replace(/\n/g, '<br>')}`;
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
        if (btn) btn.disabled = true;
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
        finally { if (btn) btn.disabled = false; }
    }

    // ==================== Memory Management (P2 治理 UI) ====================

    async openMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (modal) modal.style.display = 'flex';
        this.memoryError('');
        await this.loadMemorySettings();
        await this.loadMemories();
    }

    closeMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (modal) modal.style.display = 'none';
    }

    memoryError(msg) {
        const el = document.getElementById('memoryError');
        if (!el) return;
        el.textContent = msg || '';
        el.style.display = msg ? 'block' : 'none';
    }

    async loadMemorySettings() {
        try {
            const res = await this.apiFetch('/api/memory-settings');
            const data = await res.json();
            this._memoryEpoch = data.epoch;
            const toggle = document.getElementById('memoryEnabledToggle');
            if (toggle) toggle.checked = !!data.enabled;
            const banner = document.getElementById('memoryPausedBanner');
            if (banner) banner.style.display = data.enabled ? 'none' : 'block';
        } catch { this.memoryError('记忆设置加载失败'); }
    }

    async loadMemories() {
        const listEl = document.getElementById('memoryList');
        if (listEl) listEl.innerHTML = '<p class="memory-empty">加载中...</p>';
        try {
            const response = await this.apiFetch('/api/memories');
            if (!response.ok) throw new Error();
            const data = await response.json();
            this._memoryEpoch = data.epoch;
            this._memories = data.memories || [];
            this.renderMemories(this._memories);
        } catch {
            if (listEl) listEl.innerHTML = '<p class="memory-empty">加载失败</p>';
        }
    }

    renderMemories(memories) {
        const listEl = document.getElementById('memoryList');
        if (!listEl) return;
        const legacyBanner = document.getElementById('memoryLegacyBanner');
        const hasLegacy = memories.some(m => m.source && m.source.type === 'legacy' && m.status === 'candidate');
        if (legacyBanner) legacyBanner.style.display = hasLegacy ? 'block' : 'none';
        if (!memories.length) {
            listEl.innerHTML = '<p class="memory-empty">还没有记忆。系统只从你本人的表达中保存有来源的信息；明确稳定的陈述会自动保存并提示，不确定的会先请你确认。</p>';
            return;
        }
        const actives = memories.filter(m => m.status === 'active');
        const candidates = memories.filter(m => m.status === 'candidate');
        const userPrefs = actives.filter(m => m.scope === 'user');
        const bookItems = actives.filter(m => m.scope === 'book');
        const archived = memories.filter(m => ['completed', 'expired', 'superseded'].includes(m.status));
        const conflictFor = (c) => actives.find(a => a.key === c.key && a.scope === c.scope && (a.bookId || null) === (c.bookId || null) && a.id !== c.id);
        let html = '';
        if (candidates.length) {
            html += '<div class="memory-section-title">待确认</div>';
            html += candidates.map(m => this.memoryItemHtml(m, { conflictActive: conflictFor(m) })).join('');
        }
        if (userPrefs.length) {
            html += '<div class="memory-section-title">用户偏好（跨书共享）</div>';
            html += userPrefs.map(m => this.memoryItemHtml(m, {})).join('');
        }
        if (bookItems.length) {
            html += '<div class="memory-section-title">本书目标 / 未解问题</div>';
            html += bookItems.map(m => this.memoryItemHtml(m, {})).join('');
        }
        if (archived.length) {
            html += `<details class="memory-archived"><summary>归档（已完成/已过期/已替代 ${archived.length}）</summary>`;
            html += archived.map(m => this.memoryItemHtml(m, {})).join('');
            html += '</details>';
        }
        listEl.innerHTML = html;
        this.bindMemoryActions(listEl);
    }

    memoryItemHtml(m, { conflictActive }) {
        const kindMeta = { preference: '偏好', fact: '事实', interest: '兴趣', reading_goal: '阅读目标', open_question: '未解问题' };
        const statusMeta = { candidate: '待确认', active: '生效中', superseded: '已替代', expired: '已过期', completed: '已完成' };
        const sourceMeta = { user_message: '用户原话', user_edit: '手动编辑', user_confirmation: '用户确认', legacy: '历史记忆' };
        const safeKind = Object.prototype.hasOwnProperty.call(kindMeta, m.kind) ? m.kind : 'fact';
        const isLegacy = m.source && m.source.type === 'legacy';
        const bookTitle = m.bookId ? ((this.books.find(b => b.id === m.bookId) || {}).title || m.bookId) : '';
        const updated = (m.updatedAt || '').slice(0, 10);
        const expires = m.expiresAt ? ` · 有效至 ${m.expiresAt.slice(0, 10)}` : '';
        let actions = '';
        if (m.status === 'candidate') {
            actions = `<button class="mem-btn mem-btn-primary" data-action="confirm" data-id="${m.id}">${isLegacy ? '分类确认' : '确认'}</button>`;
        } else if (m.status === 'active') {
            if (m.kind === 'reading_goal' || m.kind === 'open_question') {
                actions += `<button class="mem-btn" data-action="complete" data-id="${m.id}">完成</button>`;
            }
        }
        if (m.status === 'candidate' || m.status === 'active') {
            actions += `<button class="mem-btn" data-action="edit" data-id="${m.id}">编辑</button>`;
        }
        if (m.source && m.source.messageId) {
            actions += `<button class="mem-btn" data-action="source" data-id="${m.id}">来源</button>`;
        }
        actions += `<button class="mem-btn mem-btn-danger" data-action="delete" data-id="${m.id}">删除</button>`;
        const conflict = conflictActive ? `
            <div class="memory-conflict">
                <div class="memory-conflict-row"><span class="memory-conflict-label">当前值</span>${this.escapeHtml(conflictActive.content)}</div>
                <div class="memory-conflict-row"><span class="memory-conflict-label">候选值</span>${this.escapeHtml(m.content)}</div>
                <div class="memory-conflict-actions">
                    <button class="mem-btn" data-action="keep-current" data-id="${m.id}">保留当前</button>
                    <button class="mem-btn mem-btn-primary" data-action="confirm" data-id="${m.id}">确认新值</button>
                </div>
            </div>` : '';
        return `
        <div class="memory-item memory-status-${m.status}" data-id="${m.id}">
            <div class="memory-item-head">
                <span class="memory-kind memory-kind-${safeKind}">${kindMeta[safeKind]}</span>
                <span class="memory-status">${statusMeta[m.status] || m.status}${isLegacy && m.status === 'candidate' ? ' · 待分类' : ''}</span>
                ${m.scope === 'book' ? `<span class="memory-book">📖 ${this.escapeHtml(bookTitle)}</span>` : ''}
            </div>
            <div class="memory-content">${this.escapeHtml(m.content)}</div>
            ${conflict}
            <div class="memory-meta">${sourceMeta[m.source ? m.source.type : ''] || '未知来源'} · 更新 ${updated}${expires} · v${m.revision}</div>
            <div class="memory-actions">${actions}</div>
        </div>`;
    }

    bindMemoryActions(listEl) {
        listEl.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.id);
                const m = (this._memories || []).find(x => x.id === id);
                if (!m) return;
                switch (btn.dataset.action) {
                    case 'confirm': this.confirmCandidate(m); break;
                    case 'keep-current': this.deleteMemoryItem(m); break;
                    case 'edit': this.editMemoryInline(m); break;
                    case 'complete': this.completeMemoryItem(m); break;
                    case 'delete': this.deleteMemoryItem(m); break;
                    case 'source': this.viewMemorySource(m); break;
                }
            });
        });
    }

    async memoryApi(path, method, body) {
        const res = await this.apiFetch(path, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = data.error || {};
            const e = new Error(err.message || '操作失败');
            e.status = res.status; e.code = err.code;
            throw e;
        }
        return data;
    }

    async confirmCandidate(m) {
        if (m.source && m.source.type === 'legacy') { this.showClassificationForm(m); return; }
        try {
            const data = await this.memoryApi(`/api/memories/${m.id}/confirm`, 'POST', { expectedRevision: m.revision, expectedEpoch: this._memoryEpoch });
            this._memoryEpoch = data.epoch;
            this.showToast('已确认记忆');
            await this.loadMemories();
        } catch (e) { this.memoryOpError(e); }
    }

    showClassificationForm(m) {
        const item = document.querySelector(`.memory-item[data-id="${m.id}"]`);
        if (!item) return;
        const books = this.books || [];
        item.innerHTML = `
            <div class="memory-item-head"><span class="memory-kind memory-kind-fact">历史记忆</span><span class="memory-status">请核定分类与作用域</span></div>
            <div class="memory-content">${this.escapeHtml(m.content)}</div>
            <div class="memory-classify">
                <label>类型 <select class="mem-classify-kind">
                    <option value="preference">偏好</option><option value="fact">事实</option><option value="interest">兴趣</option>
                    <option value="reading_goal">阅读目标</option><option value="open_question">未解问题</option>
                </select></label>
                <label>键 <input class="mem-classify-key" list="memKeyList" placeholder="如 preference.answer_length"></label>
                <datalist id="memKeyList">
                    <option value="preference.answer_length"><option value="preference.answer_format"><option value="preference.language">
                    <option value="preference.example_style"><option value="fact.role"><option value="interest.topic:主题ID">
                    <option value="reading_goal.primary"><option value="open_question:问题ID">
                </datalist>
                <label>作用域 <select class="mem-classify-scope"><option value="user">用户级</option><option value="book">书级</option></select></label>
                <label class="mem-classify-book-label" style="display:none">书籍 <select class="mem-classify-book">${books.map(b => `<option value="${this.escapeHtml(b.id)}">${this.escapeHtml(b.title)}</option>`).join('')}</select></label>
                <div class="memory-actions">
                    <button class="mem-btn mem-btn-primary mem-classify-submit">确认分类</button>
                    <button class="mem-btn mem-classify-cancel">取消</button>
                </div>
            </div>`;
        const scopeSel = item.querySelector('.mem-classify-scope');
        const kindSel = item.querySelector('.mem-classify-kind');
        const syncScope = () => {
            const kind = kindSel.value;
            if (kind === 'reading_goal' || kind === 'open_question') { scopeSel.value = 'book'; scopeSel.disabled = true; }
            else scopeSel.disabled = false;
            item.querySelector('.mem-classify-book-label').style.display = scopeSel.value === 'book' ? 'block' : 'none';
        };
        kindSel.addEventListener('change', syncScope);
        scopeSel.addEventListener('change', syncScope);
        item.querySelector('.mem-classify-cancel').addEventListener('click', () => this.renderMemories(this._memories));
        item.querySelector('.mem-classify-submit').addEventListener('click', async () => {
            const classification = {
                kind: kindSel.value,
                key: item.querySelector('.mem-classify-key').value.trim(),
                scope: scopeSel.value,
                bookId: scopeSel.value === 'book' ? item.querySelector('.mem-classify-book').value : null
            };
            try {
                const data = await this.memoryApi(`/api/memories/${m.id}/confirm`, 'POST', { expectedRevision: m.revision, expectedEpoch: this._memoryEpoch, classification });
                this._memoryEpoch = data.epoch;
                this.showToast('历史记忆已确认分类');
                await this.loadMemories();
            } catch (e) { this.memoryOpError(e); }
        });
    }

    editMemoryInline(m) {
        const item = document.querySelector(`.memory-item[data-id="${m.id}"]`);
        if (!item) return;
        const draft = (this._memoryDrafts && this._memoryDrafts[m.id]) || m.content;
        item.innerHTML = `
            <div class="memory-item-head"><span class="memory-status">编辑记忆</span></div>
            <textarea class="mem-edit-input" rows="3">${this.escapeHtml(draft)}</textarea>
            <div class="memory-actions">
                <button class="mem-btn mem-btn-primary mem-edit-save">保存</button>
                <button class="mem-btn mem-edit-cancel">取消</button>
            </div>`;
        const input = item.querySelector('.mem-edit-input');
        item.querySelector('.mem-edit-cancel').addEventListener('click', () => this.renderMemories(this._memories));
        item.querySelector('.mem-edit-save').addEventListener('click', async () => {
            const content = input.value;
            this._memoryDrafts = this._memoryDrafts || {};
            this._memoryDrafts[m.id] = content;
            try {
                const data = await this.memoryApi(`/api/memories/${m.id}`, 'PUT', { expectedRevision: m.revision, content });
                this._memoryEpoch = data.epoch;
                delete this._memoryDrafts[m.id];
                this.showToast('记忆已更新');
                await this.loadMemories();
            } catch (e) {
                if (e.status === 409) {
                    this.memoryError('版本冲突：记忆已被其他操作更新。列表已刷新，你的输入已保留，请核对后重试。');
                    await this.loadMemories();
                    this.editMemoryInline((this._memories || []).find(x => x.id === m.id) || m);
                } else this.memoryOpError(e);
            }
        });
    }

    async completeMemoryItem(m) {
        try {
            const data = await this.memoryApi(`/api/memories/${m.id}/complete`, 'POST', { expectedRevision: m.revision });
            this._memoryEpoch = data.epoch;
            this.showToast('已标记完成');
            await this.loadMemories();
        } catch (e) { this.memoryOpError(e); }
    }

    async deleteMemoryItem(m) {
        try {
            const data = await this.memoryApi(`/api/memories/${m.id}`, 'DELETE', { expectedRevision: m.revision });
            this._memoryEpoch = data.epoch;
            this.showToast('已删除记忆（旧来源不会再写回）');
            await this.loadMemories();
        } catch (e) { this.memoryOpError(e); }
    }

    memoryOpError(e) {
        this.memoryError(`${e.code || 'ERROR'}：${e.message}`);
        if (e.status === 409) this.loadMemories();
    }

    async viewMemorySource(m) {
        const listEl = document.getElementById('memoryList');
        if (!listEl || !m.source) return;
        const back = '<button class="mem-btn mem-source-back">← 返回列表</button>';
        if (!m.source.conversationId || !m.source.messageId) {
            listEl.innerHTML = `${back}<p class="memory-empty">该记忆来自${m.source.type === 'legacy' ? '历史迁移' : '手动操作'}，无对应用户原话。</p>`;
            listEl.querySelector('.mem-source-back').addEventListener('click', () => this.renderMemories(this._memories));
            return;
        }
        try {
            const res = await this.apiFetch(`/api/conversations/${m.source.conversationId}/messages`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            const msg = (data.messages || []).find(x => x.id === m.source.messageId);
            if (!msg) throw new Error();
            const text = String(msg.content || '');
            const r = m.source.range;
            let body;
            if (r && r.start >= 0 && r.end <= text.length && r.start < r.end) {
                body = this.escapeHtml(text.slice(0, r.start)) + '<mark class="memory-source-mark">' + this.escapeHtml(text.slice(r.start, r.end)) + '</mark>' + this.escapeHtml(text.slice(r.end));
            } else {
                body = this.escapeHtml(text);
            }
            listEl.innerHTML = `${back}<div class="memory-source-view"><div class="memory-meta">来源：用户原话（消息 #${m.source.messageId}）</div><div class="memory-source-text">${body}</div></div>`;
        } catch {
            listEl.innerHTML = `${back}<p class="memory-empty">来源不可用（会话已删除或无权访问）。记忆本身仍然有效，不伪造来源。</p>`;
        }
        listEl.querySelector('.mem-source-back').addEventListener('click', () => this.renderMemories(this._memories));
    }

    async clearAllMemories() {
        if (!confirm('确定清空所有 AI 记忆吗？将建立删除屏障，旧来源不会再写回。此操作不可撤销。')) return;
        try {
            const data = await this.memoryApi('/api/memories', 'DELETE', { expectedEpoch: this._memoryEpoch });
            this._memoryEpoch = data.epoch;
            this.showToast('已清空所有记忆');
            await this.loadMemories();
        } catch (e) { this.memoryOpError(e); }
    }

    async toggleMemoryEnabled(enabled) {
        try {
            const data = await this.memoryApi('/api/memory-settings', 'PUT', { enabled, expectedEpoch: this._memoryEpoch });
            this._memoryEpoch = data.epoch;
            const banner = document.getElementById('memoryPausedBanner');
            if (banner) banner.style.display = enabled ? 'none' : 'block';
            this.showToast(enabled ? '自动记忆已恢复（只处理之后的新表达）' : '自动记忆已暂停');
        } catch (e) {
            this.memoryOpError(e);
            await this.loadMemorySettings();
        }
    }

    async fetchMemoryMap() {
        try {
            const res = await this.apiFetch('/api/memories');
            if (!res.ok) return new Map();
            const data = await res.json();
            return new Map((data.memories || []).map(m => [m.id, m]));
        } catch { return new Map(); }
    }

    /** 本次参考的记忆（MemoryRef）：liveItems 优先；历史按当前记忆显示已删除/已更新，不还原旧正文 */
    renderMemoryRefs(el, refs, memoryMap = null, liveItems = null) {
        if (!el) return;
        el.innerHTML = '';
        if (!refs || !refs.length) return;
        if (!memoryMap && !liveItems) {
            this.fetchMemoryMap().then(map => this.renderMemoryRefs(el, refs, map));
            return;
        }
        const reasonMeta = { global_preference: '全局偏好', current_book: '本书目标', relevant_topic: '相关主题' };
        const wrap = document.createElement('div');
        wrap.className = 'memory-refs';
        const title = document.createElement('span');
        title.className = 'memory-refs-title';
        title.textContent = '本次参考的记忆';
        wrap.appendChild(title);
        for (const ref of refs) {
            const chip = document.createElement('button');
            chip.className = 'memory-ref-chip';
            let text;
            const live = liveItems && liveItems.find(i => i.id === ref.id);
            if (live) text = live.content;
            else {
                const m = memoryMap && memoryMap.get(ref.id);
                if (!m) { text = '已删除'; chip.classList.add('deleted'); }
                else if (m.revision !== ref.revision) { text = '已更新：' + m.content; chip.classList.add('updated'); }
                else text = m.content;
            }
            chip.textContent = `[${reasonMeta[ref.reason] || '记忆'}] ${text}`;
            chip.title = '点击查看记忆管理';
            chip.addEventListener('click', () => this.openMemoryModal());
            wrap.appendChild(chip);
        }
        el.appendChild(wrap);
    }

    /** 后处理真实状态轮询：提取完成前不宣称已保存；失败明确提示 */
    async pollMemoryPostProcessing(requestId) {
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 750));
            try {
                const res = await this.apiFetch(`/api/ask-requests/${requestId}`);
                if (!res.ok) return;
                const data = await res.json();
                const pp = data.postProcessing;
                if (!pp || pp.status === 'pending') continue;
                if (pp.status === 'failed') {
                    this.showToast(`记忆保存失败：${(pp.error && pp.error.message) || '未知原因'}`, [{ label: '查看', onClick: () => this.openMemoryModal() }], 8000);
                    return;
                }
                const changes = pp.memoryChanges || [];
                const created = changes.filter(c => c.change === 'created');
                const cand = changes.filter(c => c.change === 'candidate');
                if (created.length || cand.length) {
                    const parts = [];
                    if (created.length) parts.push(`已自动保存 ${created.length} 条记忆`);
                    if (cand.length) parts.push(`${cand.length} 条待确认`);
                    const actions = [{ label: '查看', onClick: () => this.openMemoryModal() }];
                    if (created.length) actions.unshift({ label: '撤销', onClick: () => this.undoAutoSaved(created) });
                    this.showToast(parts.join('，'), actions, 10000);
                }
                return;
            } catch { return; }
        }
    }

    async undoAutoSaved(created) {
        const map = await this.fetchMemoryMap();
        let n = 0;
        for (const c of created) {
            const m = map.get(c.id);
            if (!m) continue;
            try {
                await this.memoryApi(`/api/memories/${c.id}`, 'DELETE', { expectedRevision: m.revision });
                n++;
            } catch {}
        }
        this.showToast(n ? `已撤销 ${n} 条记忆（删除屏障已建立）` : '撤销失败：记忆可能已变化', [], 5000);
        if (document.getElementById('memoryModal').style.display !== 'none') await this.loadMemories();
    }


    async indexBook(bookId, force = false) {
        // 建索引不依赖对话提供商密钥（向量化由 RAG 设置解析，未配置时后端自动降级 BM25），不做密钥门槛拦截
        const book = this.books.find(b => b.id === bookId);

        // 非强制重建时，先查索引状态；已有索引/旧版/构建中则提供选项，避免重复耗时重建
        if (!force) {
            try {
                const res = await this.apiFetch(`/api/books/${bookId}/index-status`);
                if (res.ok) {
                    const st = await res.json();
                    if (st.usable || st.active || st.rebuildRequired || st.build) { this.showIndexExistingModal(bookId, book, st); return; }
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
            if (response.ok && data.success) {
                const active = data.active || {};
                const modeText = active.mode === 'embedding+bm25' ? '向量+BM25' : 'BM25 关键词';
                this.appendTaskLog(`<div class="log-success">✅ 索引完成：${active.chunkCount || 0} 个文本块，模式：${modeText}</div>`);
                for (const w of data.warnings || []) {
                    this.appendTaskLog(`<div class="log-error">⚠️ ${this.escapeHtml(w.message || w.code)}</div>`);
                }
                this.setTaskProgress(100, '索引完成');
            } else if (response.ok && !data.success) {
                // 重建失败但保留旧索引
                const active = data.active || {};
                this.appendTaskLog(`<div class="log-error">❌ 本次重建失败，已保留旧索引（${active.chunkCount || 0} 块）</div>`);
                for (const w of data.warnings || []) {
                    this.appendTaskLog(`<div class="log-error">⚠️ ${this.escapeHtml(w.message || w.code)}</div>`);
                }
                this.setTaskProgress(0, '重建失败，旧索引仍可用');
            } else {
                const err = data.error || {};
                const msg = err.code === 'INDEX_BUILD_RUNNING' ? '该书索引正在构建中，请稍后' : (err.message || data.error || '索引失败');
                this.appendTaskLog(`<div class="log-error">❌ ${this.escapeHtml(typeof msg === 'string' ? msg : '索引失败')}</div>`);
                this.setTaskProgress(0, '索引失败');
            }
        } catch {
            this.appendTaskLog(`<div class="log-error">❌ 网络错误</div>`);
        }
    }

    // 已存在索引时：展示状态并提供 重建/删除 选项
    showIndexExistingModal(bookId, book, st) {
        const active = st.active || {};
        const modeText = active.mode === 'embedding+bm25' ? '向量+BM25' : (active.mode === 'bm25' ? 'BM25 关键词' : '—');
        this.openTaskModal('建立智能索引');
        document.getElementById('taskProgress').style.display = 'none';
        if (st.usable && active.indexVersion) {
            this.appendTaskLog(`<div class="log-success">✅ 《${book ? book.title : ''}》已建立可定位索引</div>`);
            this.appendTaskLog(`<div class="log-info">文本块：${active.chunkCount || 0} 个 · 模式：${modeText} · 向量：${active.vectorCount || 0}</div>`);
        } else if (st.rebuildRequired) {
            this.appendTaskLog(`<div class="log-error">⚠️ 旧版索引或原文已变化，需要重建后才能定位引用</div>`);
        } else {
            this.appendTaskLog(`<div class="log-info">《${book ? book.title : ''}》尚未建立可用索引</div>`);
        }
        if (st.build && st.build.state === 'building') {
            this.appendTaskLog(`<div class="log-progress">正在构建：${st.build.processedChunks || 0}/${st.build.totalChunks || 0} 块</div>`);
        } else if (st.build && (st.build.state === 'failed' || st.build.state === 'cancelled')) {
            this.appendTaskLog(`<div class="log-error">上次构建：${st.build.state === 'failed' ? '失败' : '已取消'}${st.build.error ? '（' + this.escapeHtml(st.build.error) + '）' : ''}</div>`);
        }
        this.appendTaskLog(`<div class="log-progress">如需更新可选择重建，或不再需要时删除索引。</div>`);
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

    // ==================== 任务视图（索引弹窗 / 笔记弹窗共用渲染） ====================

    agentTaskView() {
        return {
            kind: 'agent',
            modal: this.agentTaskModal,
            title: document.getElementById('agentTaskTitle'),
            progress: document.getElementById('taskProgress'),
            fill: document.getElementById('taskProgressFill'),
            text: document.getElementById('taskProgressText'),
            log: document.getElementById('taskLog'),
            result: document.getElementById('taskResult'),
            actions: document.getElementById('taskActionBar')
        };
    }

    notesView() {
        return {
            kind: 'notes',
            modal: document.getElementById('notesModal'),
            title: document.getElementById('notesTitle'),
            progress: document.getElementById('notesProgress'),
            fill: document.getElementById('notesProgressFill'),
            text: document.getElementById('notesProgressText'),
            log: document.getElementById('notesLog'),
            result: document.getElementById('notesResult'),
            actions: document.getElementById('notesActionBar')
        };
    }

    // ==================== 读书笔记（先查看，再手动生成） ====================

    async openNotesModal(bookId) {
        const view = this.notesView();
        const book = this.books.find(b => b.id === bookId);
        const title = `读书笔记 · ${book ? book.title : ''}`;
        view.title.textContent = title;
        view.modal.classList.add('visible');

        // 该书任务仍在后台运行：直接展示实时进度，不重复发起
        if (this._notesRunningFor === bookId) {
            this.setTaskActions([{ label: '后台运行', onClick: () => this.backgroundNotesTask(view) }], view);
            return;
        }

        this.openTaskModal(title, view);
        this.setTaskProgress(0, '正在检查已保存的笔记...', view);
        try {
            const res = await this.apiFetch(`/api/agent/task/result?bookId=${encodeURIComponent(bookId)}&taskType=generate-notes`);
            const data = await res.json();
            if (data.result && data.result.content) {
                this.showSavedTaskResult('generate-notes', bookId, data.result.content, data.result.updatedAt, view);
            } else {
                const outcome = this._notesOutcomes && this._notesOutcomes[bookId];
                if (outcome && outcome.status === 'failed') this.showNotesFailed(bookId, view, outcome);
                else this.showNotesEmpty(bookId, view);
            }
        } catch {
            this.showNotesEmpty(bookId, view);
        }
    }

    // 后台任务失败留痕：重开面板如实展示原因与重试入口，而不是回到"从未生成"的空状态
    showNotesFailed(bookId, view, outcome) {
        view.progress.style.display = 'none';
        view.log.innerHTML = '';
        view.log.style.display = 'none';
        view.result.style.display = 'block';
        const time = outcome.at ? new Date(outcome.at).toLocaleString('zh-CN') : '';
        view.result.innerHTML = `
            <div class="notes-empty notes-failed">
                <span class="notes-failed-icon" aria-hidden="true">!</span>
                <p class="notes-empty-title">上次生成未完成</p>
                <p class="notes-empty-desc">${this.escapeHtml(outcome.message || '任务失败')}</p>
                <p class="notes-empty-cost">${time ? `发生于 ${time}。` : ''}失败不会保存残缺笔记，可直接重试；若多次失败，请在「设置 → 模型服务」测试连接或更换模型。</p>
            </div>`;
        this.setTaskActions([
            { label: '🔄 重新生成', primary: true, onClick: () => this.runAgentTask('generate-notes', bookId, true, view) }
        ], view);
    }

    showNotesEmpty(bookId, view) {
        const book = this.books.find(b => b.id === bookId);
        view.progress.style.display = 'none';
        view.log.innerHTML = '';
        view.log.style.display = 'none';
        view.result.style.display = 'block';
        view.result.innerHTML = `
            <div class="notes-empty">
                <span class="seal seal-lg" aria-hidden="true">读</span>
                <p class="notes-empty-title">还没有读书笔记</p>
                <p class="notes-empty-desc">AI 将通读《${this.escapeHtml(book ? book.title : '')}》全书章节，分层生成逐章摘要与原文金句，再整合为一份结构化笔记。</p>
                <p class="notes-empty-cost">全书通常需 3–5 分钟。章节摘要会自动缓存，重新生成只重跑整合，几乎不额外耗时。</p>
            </div>`;
        this.setTaskActions([
            { label: '✨ 生成笔记', primary: true, onClick: () => this.runAgentTask('generate-notes', bookId, true, view) }
        ], view);
    }

    // 关闭面板但任务继续：明确告知后台运行与完成通知
    backgroundNotesTask(view) {
        this.closeTaskModal(view);
        this.showToast('任务仍在后台运行，完成后会自动保存并通知你', [], 4000);
    }

    closeNotesModal() {
        if (this._notesRunningFor) this.backgroundNotesTask(this.notesView());
        else this.closeTaskModal(this.notesView());
    }

    async deleteSavedNote(bookId, view) {
        if (!confirm('确定删除已保存的读书笔记吗？删除后可重新生成。')) return;
        try {
            const res = await this.apiFetch(`/api/agent/task/result?bookId=${encodeURIComponent(bookId)}&taskType=generate-notes`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { this.showToast('笔记已删除'); this.showNotesEmpty(bookId, view); }
            else this.showToast(data.error || '删除失败');
        } catch { this.showToast('删除失败'); }
    }

    async runAgentTask(taskType, bookId, force = false, view = this.agentTaskView()) {
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        const book = this.books.find(b => b.id === bookId);
        const titleMap = { 'generate-notes': '生成读书笔记', 'character-analysis': '人物关系分析' };
        const isNotes = view.kind === 'notes';

        // 非强制重生成时，优先复用已保存的结果
        if (!force) {
            try {
                const res = await this.apiFetch(`/api/agent/task/result?bookId=${encodeURIComponent(bookId)}&taskType=${encodeURIComponent(taskType)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.result && data.result.content) {
                        this.showSavedTaskResult(taskType, bookId, data.result.content, data.result.updatedAt, view);
                        return;
                    }
                }
            } catch {}
        }

        this.openTaskModal(isNotes ? `读书笔记 · ${book ? book.title : ''}` : (titleMap[taskType] || 'AI 智能任务'), view);
        this.appendTaskLog(`<div class="log-info">开始为《${book ? book.title : ''}》执行：${titleMap[taskType] || taskType}</div>`, view);
        if (isNotes) {
            this._notesRunningFor = bookId;
            if (this._notesOutcomes) delete this._notesOutcomes[bookId];
            this.setTaskActions([{ label: '后台运行', onClick: () => this.backgroundNotesTask(view) }], view);
            this.renderBooks();
        }

        try {
            const response = await this.apiFetch('/api/agent/task', {
                method: 'POST',
                body: JSON.stringify({ taskType, bookId, provider: this.currentProvider, model: this.currentModel })
            });
            if (!response.ok) {
                const data = await response.json();
                this.appendTaskLog(`<div class="log-error">❌ ${data.error}</div>`, view);
                if (isNotes) {
                    this.setNotesOutcome(bookId, 'failed', data.error || '请求失败');
                    if (!view.modal.classList.contains('visible')) this.showToast('笔记生成失败，可打开「笔记」查看原因并重试');
                }
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
                            this.appendTaskLog(`<div class="log-info">📋 任务：${evt.taskName}（${evt.nodes.length} 个子 Agent 并行编排）</div>`, view);
                        } else if (evt.type === 'node_start') {
                            this.appendTaskLog(`<div class="log-node">▶️ ${evt.name} 启动</div>`, view);
                            this.setTaskProgress(this._taskPercent || 0, `${evt.name} 运行中…`, view);
                        } else if (evt.type === 'node_progress') {
                            if (evt.chunk) {
                                this.appendNoteChunk(evt.chunk, view);
                            } else {
                                this.appendTaskLog(`<div class="log-progress"> ${evt.stage || ''}</div>`, view);
                                if (evt.stage) this.setTaskProgress(this._taskPercent || 0, evt.stage, view);
                            }
                        } else if (evt.type === 'node_done') {
                            this.appendTaskLog(`<div class="log-success">✅ ${evt.name} 完成</div>`, view);
                        } else if (evt.type === 'node_error') {
                            this.appendTaskLog(`<div class="log-error">⚠️ ${evt.name} 失败：${evt.error}（已降级跳过）</div>`, view);
                        } else if (evt.type === 'progress') {
                            this._taskPercent = evt.percent;
                            this.setTaskProgress(evt.percent, `${evt.progress}/${evt.total} 节点完成`, view);
                        } else if (evt.type === 'result') {
                            const final = evt.final || {};
                            const content = final.note || final.report || '';
                            if (content) {
                                const sm = evt.outputs && evt.outputs.summaries;
                                if (isNotes && sm && sm.cachedCount > 0) {
                                    this.appendTaskLog(`<div class="log-success">♻️ 复用缓存章节摘要 ${sm.cachedCount}/${sm.totalChapters} 章，仅重跑整合</div>`, view);
                                }
                                this.renderTaskResult(content, view);
                                this._taskContext = { taskType, bookId, content };
                                this.showTaskResultActions(taskType, bookId, null, view);
                                if (isNotes) {
                                    this.setNotesOutcome(bookId, 'completed');
                                    if (!view.modal.classList.contains('visible')) {
                                        this.showToast(`《${book ? book.title : ''}》读书笔记已生成`, [{ label: '查看', onClick: () => this.openNotesModal(bookId) }], 8000);
                                    }
                                }
                            } else {
                                this.appendTaskLog(`<div class="log-error">⚠️ 任务未产生有效结果，请检查 API 密钥与模型是否可用（模型不支持或超时会导致所有子 Agent 降级失败）</div>`, view);
                                if (isNotes) {
                                    this.setNotesOutcome(bookId, 'failed', '任务未产生有效结果：模型不支持或超时，导致所有子 Agent 降级失败。');
                                    if (!view.modal.classList.contains('visible')) this.showToast('笔记生成失败，可打开「笔记」查看原因并重试');
                                }
                            }
                        } else if (evt.type === 'task_done') {
                            this.setTaskProgress(100, '任务完成', view);
                        } else if (evt.type === 'error') {
                            this.appendTaskLog(`<div class="log-error">❌ ${evt.error}</div>`, view);
                            if (isNotes) {
                                this.setNotesOutcome(bookId, 'failed', evt.error || '任务执行出错');
                                if (!view.modal.classList.contains('visible')) this.showToast('笔记生成失败，可打开「笔记」查看原因并重试');
                            }
                        }
                    } catch {}
                }
            }
        } catch {
            this.appendTaskLog(`<div class="log-error">❌ 网络错误</div>`, view);
            if (isNotes) this.setNotesOutcome(bookId, 'failed', '网络错误：与服务器的连接中断，任务可能仍在服务器运行，请稍后重开查看。');
        } finally {
            if (isNotes) {
                this._notesRunningFor = null;
                this.renderBooks();
            }
        }
    }

    setNotesOutcome(bookId, status, message = '') {
        this._notesOutcomes = this._notesOutcomes || {};
        this._notesOutcomes[bookId] = { status, message, at: Date.now() };
    }

    openTaskModal(title, view = this.agentTaskView()) {
        view.title.textContent = title || 'AI 智能任务';
        view.log.innerHTML = '';
        view.log.style.display = '';
        view.result.style.display = 'none';
        view.result.innerHTML = '';
        view.progress.style.display = 'block';
        this.setTaskActions([], view);
        this._taskPercent = 0;
        this._noteStream = '';
        this.setTaskProgress(0, '准备中...', view);
        view.modal.classList.add('visible');
    }

    // 整合层流式输出：边生成边显示纯文本，终态由 result 事件渲染为 Markdown
    appendNoteChunk(chunk, view) {
        this._noteStream = (this._noteStream || '') + chunk;
        view.result.style.display = 'block';
        view.result.textContent = this._noteStream;
        view.result.scrollTop = view.result.scrollHeight;
        this.setTaskProgress(this._taskPercent || 0, '整合输出中…', view);
    }

    // 动态设置任务弹窗的操作按钮
    setTaskActions(actions, view = this.agentTaskView()) {
        const bar = view.actions;
        if (!bar) return;
        if (!actions || !actions.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
        bar.innerHTML = '';
        actions.forEach(a => {
            const btn = document.createElement('button');
            btn.className = `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger-ghost' : 'btn-secondary'}`;
            btn.textContent = a.label;
            btn.addEventListener('click', a.onClick);
            bar.appendChild(btn);
        });
        bar.style.display = 'flex';
    }

    // 展示已保存的任务结果（无需重新生成）
    showSavedTaskResult(taskType, bookId, content, updatedAt, view = this.agentTaskView()) {
        const titleMap = { 'generate-notes': '读书笔记', 'character-analysis': '人物关系分析' };
        if (view.kind !== 'notes') view.title.textContent = titleMap[taskType] || 'AI 智能任务';
        view.log.innerHTML = '';
        view.progress.style.display = 'none';
        this._taskContext = { taskType, bookId, content };
        this.renderTaskResult(content, view);
        this.showTaskResultActions(taskType, bookId, updatedAt, view);
        view.modal.classList.add('visible');
    }

    // 结果视图的操作按钮：导出 / 查看阅读 / 重新生成（笔记另有删除）
    showTaskResultActions(taskType, bookId, updatedAt, view = this.agentTaskView()) {
        const timeText = updatedAt ? `（生成于 ${new Date(updatedAt).toLocaleString('zh-CN')}）` : '';
        this.appendTaskLog(`<div class="log-success">${updatedAt ? `✅ 已展示上次生成的结果${timeText}` : '✅ 笔记已生成并自动保存'}</div>`, view);
        const actions = [
            { label: '📥 导出 Markdown', onClick: () => this.exportTaskResult() },
            { label: '📖 查看阅读', onClick: () => { this.closeTaskModal(view); this.openBook(bookId); } },
            { label: '🔄 重新生成', primary: true, onClick: () => this.runAgentTask(taskType, bookId, true, view) }
        ];
        if (view.kind === 'notes') {
            actions.push({ label: '删除笔记', danger: true, onClick: () => this.deleteSavedNote(bookId, view) });
        }
        this.setTaskActions(actions, view);
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

    closeTaskModal(view = this.agentTaskView()) {
        view.modal.classList.remove('visible');
    }

    appendTaskLog(html, view = this.agentTaskView()) {
        const line = document.createElement('div');
        line.innerHTML = html;
        view.log.style.display = '';
        view.log.appendChild(line);
        view.log.scrollTop = view.log.scrollHeight;
    }

    setTaskProgress(percent, text, view = this.agentTaskView()) {
        view.fill.style.width = percent + '%';
        view.text.textContent = text;
    }

    renderTaskResult(content, view = this.agentTaskView()) {
        view.result.style.display = 'block';
        view.result.innerHTML = this.renderMarkdown(content);
    }

    renderMarkdown(text) {
        if (!text) return '';
        let html = this.escapeHtml(text);
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        html = html.replace(/^- (.+)$/gm, '<div class="md-li">$1</div>');
        html = html.replace(/\n/g, '<br>');
        // 块级元素前后的 <br> 去掉，避免多余空行
        html = html.replace(/<br>\s*(<(?:h2|h3|h4|blockquote|div class="md-li")>)/g, '$1');
        html = html.replace(/(<\/(?:h2|h3|h4|blockquote|div)>)\s*<br>/g, '$1');
        return html;
    }

    // ==================== Providers ====================

    static PRESETS = {
        siliconflow: { name: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', models: 'Qwen/Qwen2.5-72B-Instruct\nTHUDM/glm-4-9b-chat' },
        dashscope: { name: '阿里云百炼', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: 'qwen-turbo\nqwen-max' },
        deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: 'deepseek-reasoner' },
        zhipu: { name: '智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', models: 'glm-4-air\nglm-4-flash' },
        moonshot: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', models: 'moonshot-v1-32k\nmoonshot-v1-128k' },
        openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', models: 'gpt-4o' }
    };

    async loadProviders() {
        try {
            const response = await this.apiFetch('/api/providers');
            const data = await response.json();
            this.providers = data.providers || [];
            // 保存的选择失效（含旧内置预设）时回落到第一个自定义提供商
            const customs = this.providers.filter(p => p.isCustom);
            if (!customs.some(p => p.id === this.currentProvider)) {
                this.currentProvider = customs.length ? customs[0].id : 'custom';
                localStorage.setItem('selectedProvider', this.currentProvider);
            }
            if (this.currentProvider !== 'custom') {
                this.currentModel = localStorage.getItem(`selectedModel_${this.currentProvider}`) || null;
            }
            this.renderProviders();
        } catch (error) { console.error('加载提供商失败:', error); }
    }

    getCustomModels(providerId) { try { return JSON.parse(localStorage.getItem(`customModels_${providerId}`)) || []; } catch { return []; } }

    getProviderModels(providerInfo) {
        const models = [], addedIds = new Set();
        if (providerInfo.defaultModel) { models.push({ id: providerInfo.defaultModel, name: providerInfo.defaultModel }); addedIds.add(providerInfo.defaultModel); }
        (providerInfo.models || []).forEach(m => { if (!addedIds.has(m.id)) { models.push(m); addedIds.add(m.id); } });
        this.getCustomModels(providerInfo.id).forEach(m => { if (!addedIds.has(m.id)) { models.push(m); addedIds.add(m.id); } });
        return models;
    }

    providerMarkColor(id) {
        const covers = ['#1e5b45', '#c2401f', '#3b4a6b', '#b45309', '#2a7d7b', '#7d3a5c', '#6b7a2a', '#4a5568'];
        let h = 0;
        for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
        return covers[h % covers.length];
    }

    renderProviders() {
        if (!this.providerList) return;
        const customs = this.providers.filter(p => p.isCustom);
        const empty = document.getElementById('providerEmpty');
        if (!customs.length) {
            this.providerList.innerHTML = '';
            if (empty) empty.hidden = false;
            return;
        }
        if (empty) empty.hidden = true;
        this.providerList.innerHTML = customs.map(p => this.providerCardHtml(p)).join('');
    }

    providerCardHtml(p) {
        const active = p.id === this.currentProvider;
        const keyInfo = this.apiProviders[p.id] || {};
        const models = this.getProviderModels(p);
        const model = (active ? this.currentModel : null) || p.defaultModel || '';
        const host = (p.apiEndpoint || '').replace(/^https?:\/\//, '').replace(/\/chat\/completions$/, '');
        const initial = (p.name || '?').trim().charAt(0).toUpperCase();
        const esc = (s) => this.escapeHtml(String(s == null ? '' : s));

        const badges = [
            active ? '<span class="badge badge-active">使用中</span>' : '',
            keyInfo.hasKey ? '<span class="badge badge-ok">已连接</span>' : '<span class="badge badge-warn">未配置密钥</span>'
        ].join('');

        const subParts = [];
        if (host) subParts.push(esc(host));
        if (keyInfo.maskedKey) subParts.push(`<span class="masked">${esc(keyInfo.maskedKey)}</span>`);
        if (keyInfo.lastUpdated) subParts.push(`更新于 ${new Date(keyInfo.lastUpdated).toLocaleDateString('zh-CN')}`);

        const modelRow = active && models.length
            ? `<div class="provider-model-row"><span>模型</span><select class="model-select-inline" data-provider-id="${esc(p.id)}" title="切换当前模型">${models.map(m => `<option value="${esc(m.id)}"${m.id === model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`
            : `<div class="provider-model-row"><span>默认模型</span><strong>${esc(model)}</strong></div>`;

        return `
            <article class="provider-card${active ? ' is-active' : ''}" data-provider-id="${esc(p.id)}">
                <div class="provider-mark" style="--mark:${this.providerMarkColor(p.id)}">${esc(initial)}</div>
                <div class="provider-main">
                    <div class="provider-name-row"><span class="provider-name">${esc(p.name)}</span>${badges}</div>
                    <div class="provider-sub mono">${subParts.join(' · ')}</div>
                    ${modelRow}
                </div>
                <div class="provider-actions">
                    ${active ? '' : '<button class="btn btn-secondary btn-sm" data-action="activate">启用</button>'}
                    <button class="icon-btn" data-action="verify" title="测试连接">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </button>
                    <button class="icon-btn" data-action="edit" title="编辑提供商">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                    <button class="icon-btn danger" data-action="delete" title="删除提供商">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </article>`;
    }

    activateProvider(providerId) {
        const p = this.providers.find(x => x.id === providerId);
        if (!p) return;
        this.currentProvider = providerId;
        this.currentModel = localStorage.getItem(`selectedModel_${providerId}`) || p.defaultModel || null;
        localStorage.setItem('selectedProvider', providerId);
        if (this.currentModel) localStorage.setItem(`selectedModel_${providerId}`, this.currentModel);
        this.renderProviders();
        this.showToast(`已切换到「${p.name}」`);
    }

    async verifyProvider(providerId, btn) {
        const p = this.providers.find(x => x.id === providerId);
        if (btn) btn.classList.add('loading');
        try {
            const response = await this.apiFetch('/api/key/verify', { method: 'POST', body: JSON.stringify({ provider: providerId }) });
            const data = await response.json();
            this.showToast(data.valid ? `「${p ? p.name : providerId}」连接正常` : (data.error || '验证失败：密钥无效或端点不可达'));
        } catch { this.showToast('验证失败：网络错误'); }
        finally { if (btn) btn.classList.remove('loading'); }
    }

    openProviderModal(mode, provider = null) {
        this._pmMode = mode;
        this._pmId = provider ? provider.id : null;
        const isEdit = mode === 'edit';
        document.getElementById('providerModalTitle').textContent = isEdit ? '编辑提供商' : '添加提供商';
        document.getElementById('pmPresetRow').style.display = isEdit ? 'none' : '';
        document.getElementById('pmName').value = provider ? provider.name : '';
        document.getElementById('pmEndpoint').value = provider ? (provider.apiEndpoint || '') : '';
        document.getElementById('pmModel').value = provider ? (provider.defaultModel || '') : '';
        document.getElementById('pmModels').value = provider ? (provider.models || []).map(m => m.id).join('\n') : '';
        document.getElementById('pmKey').value = '';
        const keyInfo = provider ? (this.apiProviders[provider.id] || {}) : {};
        document.getElementById('pmKeyStatus').textContent = isEdit && keyInfo.hasKey ? `（已配置 ${keyInfo.maskedKey || ''}，留空则不修改）` : '';
        document.getElementById('pmKeyRequired').style.display = isEdit ? 'none' : '';
        document.getElementById('pmKeyHint').textContent = isEdit ? '留空保持现有密钥；填写新密钥会先验证再替换。' : '保存前会先向该端点验证密钥，确认可用后才写入。';
        document.getElementById('pmDeleteKeyBtn').style.display = isEdit && keyInfo.hasKey ? '' : 'none';
        document.getElementById('pmError').style.display = 'none';
        document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
        this.providerModal.classList.add('visible');
        document.getElementById('pmName').focus();
    }

    closeProviderModal() {
        this.providerModal.classList.remove('visible');
        document.getElementById('pmError').style.display = 'none';
    }

    applyProviderPreset(key, chip) {
        const preset = AIReadingAssistant.PRESETS[key];
        if (!preset) return;
        document.getElementById('pmName').value = preset.name;
        document.getElementById('pmEndpoint').value = preset.endpoint;
        document.getElementById('pmModel').value = preset.model;
        document.getElementById('pmModels').value = preset.models || '';
        document.querySelectorAll('.preset-chip').forEach(c => c.classList.toggle('active', c === chip));
        document.getElementById('pmKey').focus();
    }

    parseModelList(text) {
        const ids = [...new Set(String(text || '').split(/[\n,，;；]/).map(s => s.trim()).filter(Boolean))];
        return ids.map(id => ({ id, name: id }));
    }

    async saveProviderFromModal() {
        const name = document.getElementById('pmName').value.trim();
        const apiEndpoint = document.getElementById('pmEndpoint').value.trim();
        const defaultModel = document.getElementById('pmModel').value.trim();
        const models = this.parseModelList(document.getElementById('pmModels').value);
        const apiKey = document.getElementById('pmKey').value.trim();
        const isEdit = this._pmMode === 'edit';
        const errEl = document.getElementById('pmError');
        const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

        if (!name || !apiEndpoint || !defaultModel) { fail('请填写名称、API 地址和默认模型'); return; }
        if (!isEdit && !apiKey) { fail('请填写 API 密钥'); return; }
        errEl.style.display = 'none';

        const btn = document.getElementById('pmSaveBtn');
        btn.classList.add('loading'); btn.disabled = true;
        try {
            if (!isEdit) {
                const response = await this.apiFetch('/api/providers', {
                    method: 'POST',
                    body: JSON.stringify({ name, apiEndpoint, defaultModel, models: models.length ? models : null, apiKey })
                });
                const data = await response.json();
                if (!response.ok) { fail(data.error || '添加失败'); return; }
                this.closeProviderModal();
                this.showToast(`「${name}」已添加，密钥验证通过`);
                await this.loadProviders();
                await this.checkApiKeyStatus();
                if (data.provider && data.provider.id) {
                    this.currentProvider = data.provider.id;
                    this.currentModel = defaultModel;
                    localStorage.setItem('selectedProvider', this.currentProvider);
                    localStorage.setItem(`selectedModel_${this.currentProvider}`, defaultModel);
                    this.renderProviders();
                }
            } else {
                const response = await this.apiFetch(`/api/providers/${this._pmId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name, apiEndpoint, defaultModel, models: models.length ? models : null })
                });
                const data = await response.json();
                if (!response.ok) { fail(data.error || '保存失败'); return; }
                if (apiKey) {
                    const keyRes = await this.apiFetch('/api/key/set', { method: 'POST', body: JSON.stringify({ apiKey, provider: this._pmId }) });
                    if (!keyRes.ok) {
                        const kd = await keyRes.json().catch(() => ({}));
                        fail(`提供商信息已保存，但新密钥验证失败：${kd.error || '请检查密钥'}`);
                        await this.loadProviders();
                        await this.checkApiKeyStatus();
                        return;
                    }
                }
                this.closeProviderModal();
                this.showToast('提供商已保存');
                await this.loadProviders();
                await this.checkApiKeyStatus();
            }
        } catch { fail('网络错误，请检查服务器连接'); }
        finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async deleteProvider(providerId) {
        const p = this.providers.find(x => x.id === providerId);
        if (!p || !confirm(`确定删除「${p.name}」吗？其 API 密钥将一并删除。`)) return;
        try {
            const response = await this.apiFetch(`/api/providers/${providerId}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) {
                this.showToast('已删除');
                if (this.currentProvider === providerId) {
                    const rest = this.providers.filter(x => x.isCustom && x.id !== providerId);
                    this.currentProvider = rest.length ? rest[0].id : 'custom';
                    this.currentModel = null;
                    localStorage.setItem('selectedProvider', this.currentProvider);
                }
                await this.loadProviders();
                await this.checkApiKeyStatus();
            } else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    async deleteProviderKeyFromModal() {
        const providerId = this._pmId;
        if (!providerId || !confirm('确定删除该提供商的 API 密钥吗？删除后 AI 功能将暂停，直到重新配置。')) return;
        try {
            const response = await this.apiFetch('/api/key', { method: 'DELETE', body: JSON.stringify({ provider: providerId }) });
            const data = await response.json();
            if (data.success) {
                this.showToast('密钥已删除');
                await this.checkApiKeyStatus();
                document.getElementById('pmKeyStatus').textContent = '';
                document.getElementById('pmKeyRequired').style.display = '';
                document.getElementById('pmDeleteKeyBtn').style.display = 'none';
            } else { this.showToast(data.error || '删除失败'); }
        } catch { this.showToast('删除失败'); }
    }

    initProviderListeners() {
        document.getElementById('addProviderBtn').addEventListener('click', () => this.openProviderModal('add'));
        document.getElementById('emptyAddProviderBtn').addEventListener('click', () => this.openProviderModal('add'));
        document.getElementById('pmCloseBtn').addEventListener('click', () => this.closeProviderModal());
        document.getElementById('pmCancelBtn').addEventListener('click', () => this.closeProviderModal());
        document.getElementById('pmSaveBtn').addEventListener('click', () => this.saveProviderFromModal());
        document.getElementById('pmDeleteKeyBtn').addEventListener('click', () => this.deleteProviderKeyFromModal());
        document.getElementById('pmKeyToggle').addEventListener('click', () => this.toggleKeyVisibility('pmKey'));
        this.providerModal.addEventListener('click', (e) => { if (e.target === this.providerModal) this.closeProviderModal(); });
        document.getElementById('pmKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.saveProviderFromModal(); } });
        document.getElementById('pmPresetRow').addEventListener('click', (e) => {
            const chip = e.target.closest('.preset-chip');
            if (chip) this.applyProviderPreset(chip.dataset.preset, chip);
        });

        // 卡片操作（事件委托）
        this.providerList.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const card = btn.closest('.provider-card');
            if (!card) return;
            const id = card.dataset.providerId;
            switch (btn.dataset.action) {
                case 'activate': this.activateProvider(id); break;
                case 'verify': this.verifyProvider(id, btn); break;
                case 'edit': this.openProviderModal('edit', this.providers.find(p => p.id === id)); break;
                case 'delete': this.deleteProvider(id); break;
            }
        });
        this.providerList.addEventListener('change', (e) => {
            const sel = e.target.closest('.model-select-inline');
            if (!sel) return;
            this.currentModel = sel.value;
            localStorage.setItem(`selectedModel_${sel.dataset.providerId}`, sel.value);
        });
    }

    // ==================== API Key ====================

    initApiKeyListeners() {
        document.getElementById('closeModalBtn').addEventListener('click', () => this.hideModal());
        document.getElementById('modalCancelBtn').addEventListener('click', () => this.hideModal());
        document.getElementById('modalSaveBtn').addEventListener('click', () => this.saveApiKeyFromModal());
        document.getElementById('modalSetupBtn').addEventListener('click', () => {
            this.hideModal();
            if (this.isReading) this.exitReading();
            this.switchView('settings');
            this.switchSettingsPage('models');
            this.openProviderModal('add');
        });
        this.apiKeyModal.addEventListener('click', (e) => { if (e.target === this.apiKeyModal) this.hideModal(); });
        document.getElementById('modalApiKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveApiKeyFromModal(); });

        // 智能索引（RAG）设置
        document.getElementById('embedProviderSelect').addEventListener('change', () => this.updateEmbedConfigVisibility());
        document.getElementById('saveEmbedSettingsBtn').addEventListener('click', () => this.saveEmbeddingSettings());
        document.getElementById('deleteEmbedKeyBtn').addEventListener('click', () => this.deleteEmbedAliyunKey());
        document.getElementById('deleteCustomEmbedKeyBtn').addEventListener('click', () => this.deleteCustomEmbedKey());
        // 重排序（Rerank）设置
        document.getElementById('saveRerankSettingsBtn').addEventListener('click', () => this.saveRerankSettings());
        document.getElementById('deleteRerankKeyBtn').addEventListener('click', () => this.deleteRerankKey());
        document.getElementById('rerankEnabled').addEventListener('change', () => this.updateRerankConfigVisibility());
    }

    // ==================== Embedding (RAG) Settings ====================

    updateEmbedConfigVisibility() {
        const provider = document.getElementById('embedProviderSelect').value;
        // auto 也可能用到阿里云/自定义，展示配置区便于填写
        document.getElementById('embedAliyunConfig').style.display =
            (provider === 'aliyun' || provider === 'auto') ? 'block' : 'none';
        document.getElementById('embedCustomConfig').style.display =
            (provider === 'custom' || provider === 'auto') ? 'block' : 'none';
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
            const custom = data.custom || {};
            document.getElementById('embedCustomBaseUrl').value = custom.baseUrl || '';
            document.getElementById('embedCustomModel').value = custom.model || '';
            document.getElementById('embedCustomKeyStatus').textContent = custom.hasKey ? `（已配置 ${custom.maskedKey || ''}，留空则不修改）` : '';
            document.getElementById('deleteCustomEmbedKeyBtn').style.display = custom.maskedKey ? 'inline-flex' : 'none';
            const hint = document.getElementById('embedActiveHint');
            hint.classList.remove('is-ok', 'is-warn');
            if (!data.vectorAvailable) {
                hint.textContent = '⚠️ 服务端向量扩展不可用，当前仅支持 BM25 检索';
                hint.classList.add('is-warn');
            } else if (data.provider === 'off') {
                hint.textContent = '已关闭向量化，建索引时仅使用 BM25 关键词检索';
            } else if (data.active) {
                hint.textContent = `✅ 当前生效：${data.active.providerName} · ${data.active.model}`;
                hint.classList.add('is-ok');
            } else {
                hint.textContent = '⚠️ 暂无可用的向量化提供商（未配置密钥），建索引时将使用 BM25。';
                hint.classList.add('is-warn');
            }
            this.updateEmbedConfigVisibility();
            this.loadRerankSettings();
        } catch {}
    }

    async saveEmbeddingSettings() {
        const btn = document.getElementById('saveEmbedSettingsBtn');
        const provider = document.getElementById('embedProviderSelect').value;
        const aliyunBaseUrl = document.getElementById('embedAliyunBaseUrl').value.trim();
        const aliyunModel = document.getElementById('embedAliyunModel').value.trim();
        const aliyunApiKey = document.getElementById('embedAliyunKey').value.trim();
        const customBaseUrl = document.getElementById('embedCustomBaseUrl').value.trim();
        const customModel = document.getElementById('embedCustomModel').value.trim();
        const customApiKey = document.getElementById('embedCustomKey').value.trim();
        if (provider === 'aliyun' && (!aliyunBaseUrl || !aliyunModel)) {
            this.showToast('请填写阿里云接口地址和模型名称');
            return;
        }
        if (provider === 'custom' && (!customBaseUrl || !customModel)) {
            this.showToast('请填写自定义接口地址和模型名称');
            return;
        }
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const body = { provider, aliyunBaseUrl, aliyunModel, customBaseUrl, customModel };
            if (aliyunApiKey) body.aliyunApiKey = aliyunApiKey;
            if (customApiKey) body.customApiKey = customApiKey;
            const res = await this.apiFetch('/api/embedding-settings', { method: 'PUT', body: JSON.stringify(body) });
            const data = await res.json();
            if (res.ok) {
                this.showToast(data.active ? `设置已保存，当前生效：${data.active.providerName}` : '设置已保存（当前无可用向量化，将使用 BM25）');
                document.getElementById('embedAliyunKey').value = '';
                document.getElementById('embedCustomKey').value = '';
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

    async deleteCustomEmbedKey() {
        if (!confirm('确定删除自定义 Embedding 密钥吗？删除后相关书籍检索将降级为 BM25。')) return;
        try {
            const res = await this.apiFetch('/api/embedding-settings/custom-key', { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { this.showToast('密钥已删除'); this.loadEmbeddingSettings(); }
            else this.showToast(data.error || '删除失败');
        } catch { this.showToast('删除失败'); }
    }

    // ==================== Rerank Settings ====================

    updateRerankConfigVisibility() {
        const enabled = document.getElementById('rerankEnabled').checked;
        document.getElementById('rerankConfig').style.opacity = enabled ? '1' : '0.5';
    }

    async loadRerankSettings() {
        try {
            const res = await this.apiFetch('/api/rerank-settings');
            if (!res.ok) return;
            const data = await res.json();
            document.getElementById('rerankEnabled').checked = !!data.enabled;
            document.getElementById('rerankBaseUrl').value = data.baseUrl || '';
            document.getElementById('rerankModel').value = data.model || '';
            document.getElementById('rerankTopN').value = data.topN || 10;
            document.getElementById('rerankKeyStatus').textContent = data.hasKey ? `（已配置 ${data.maskedKey || ''}，留空则不修改）` : '';
            document.getElementById('deleteRerankKeyBtn').style.display = data.maskedKey ? 'inline-flex' : 'none';
            const hint = document.getElementById('rerankActiveHint');
            hint.classList.remove('is-ok', 'is-warn');
            if (data.active) {
                hint.textContent = `✅ 当前生效：${data.active.model} · Top ${data.active.topN}`;
                hint.classList.add('is-ok');
            } else if (data.enabled) {
                hint.textContent = '⚠️ 已启用但配置不完整（需地址/模型/密钥）';
                hint.classList.add('is-warn');
            } else {
                hint.textContent = '未启用';
            }
            this.updateRerankConfigVisibility();
        } catch {}
    }

    async saveRerankSettings() {
        const btn = document.getElementById('saveRerankSettingsBtn');
        const enabled = document.getElementById('rerankEnabled').checked;
        const baseUrl = document.getElementById('rerankBaseUrl').value.trim();
        const model = document.getElementById('rerankModel').value.trim();
        const topN = parseInt(document.getElementById('rerankTopN').value, 10) || 10;
        const rerankApiKey = document.getElementById('rerankKey').value.trim();
        if (enabled && (!baseUrl || !model)) {
            this.showToast('启用重排需填写接口地址和模型名称');
            return;
        }
        btn.classList.add('loading'); btn.disabled = true;
        try {
            const body = { enabled, baseUrl, model, topN };
            if (rerankApiKey) body.rerankApiKey = rerankApiKey;
            const res = await this.apiFetch('/api/rerank-settings', { method: 'PUT', body: JSON.stringify(body) });
            const data = await res.json();
            if (res.ok) {
                this.showToast(data.active ? `重排设置已保存，当前生效：${data.active.model}` : '重排设置已保存');
                document.getElementById('rerankKey').value = '';
                this.loadRerankSettings();
            } else {
                this.showToast(data.error || '保存失败');
            }
        } catch { this.showToast('保存失败'); } finally { btn.classList.remove('loading'); btn.disabled = false; }
    }

    async deleteRerankKey() {
        if (!confirm('确定删除重排密钥吗？删除后重排将不可用。')) return;
        try {
            const res = await this.apiFetch('/api/rerank-settings/key', { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { this.showToast('密钥已删除'); this.loadRerankSettings(); }
            else this.showToast(data.error || '删除失败');
        } catch { this.showToast('删除失败'); }
    }

    async checkApiKeyStatus() {
        try {
            const response = await this.apiFetch('/api/key/status');
            const data = await response.json();
            this.apiProviders = data.providers || {};
        } catch { this.apiProviders = this.apiProviders || {}; }
        this.renderProviders();
    }

    toggleKeyVisibility(inputId) { const i = document.getElementById(inputId); i.type = i.type === 'password' ? 'text' : 'password'; }

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

    showModal() {
        const customs = this.providers.filter(p => p.isCustom);
        const hint = document.getElementById('modalHint');
        const keyGroup = document.getElementById('modalKeyGroup');
        const setupBtn = document.getElementById('modalSetupBtn');
        const saveBtn = document.getElementById('modalSaveBtn');
        if (customs.length) {
            const p = customs.find(x => x.id === this.currentProvider) || customs[0];
            hint.textContent = `「${p.name}」尚未配置 API 密钥，配置后即可使用 AI 功能。`;
            keyGroup.style.display = '';
            setupBtn.style.display = 'none';
            saveBtn.style.display = '';
        } else {
            hint.textContent = '还没有模型提供商。先添加一个 OpenAI 兼容端点（Base URL + 密钥 + 模型），即可开始 AI 问答。';
            keyGroup.style.display = 'none';
            setupBtn.style.display = '';
            saveBtn.style.display = 'none';
        }
        this.apiKeyModal.classList.add('visible');
        if (customs.length) document.getElementById('modalApiKeyInput').focus();
    }
    hideModal() { this.apiKeyModal.classList.remove('visible'); document.getElementById('modalApiKeyInput').value = ''; }

    // ==================== History ====================

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
            this.closeProviderModal();
            this.closeNotesModal();
            this.closeTocDrawer();
            if (this.isReading && this.toolbarsVisible) this.hideToolbars();
        }
    }

    // ==================== Utils ====================

    showToast(message, actions = [], timeoutMs = 3000) {
        this.toast.textContent = message;
        this.toast.querySelectorAll('.toast-action').forEach(b => b.remove());
        for (const a of actions) {
            const b = document.createElement('button');
            b.className = 'toast-action';
            b.textContent = a.label;
            b.addEventListener('click', () => { this.toast.classList.remove('show'); if (a.onClick) a.onClick(); });
            this.toast.appendChild(b);
        }
        this.toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this.toast.classList.remove('show'), timeoutMs);
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
