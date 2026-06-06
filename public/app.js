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
        this.toolbarsVisible = false;

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

    // ==================== Event Listeners ====================

    initEventListeners() {
        // Bottom navigation
        document.querySelectorAll('.bottom-nav-item').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e.currentTarget.dataset.view));
        });

        // History clear button
        document.getElementById('clearHistoryBtn').addEventListener('click', () => this.clearHistory());

        // Text selection (in reading view)
        document.addEventListener('mouseup', (e) => this.handleTextSelection(e));
        document.addEventListener('mousedown', (e) => this.handleMouseDown(e));

        // Floating toolbar
        this.floatingToolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.toolbar-btn');
            if (btn) this.handleToolbarAction({ currentTarget: btn });
        });

        // AI sheet actions
        document.getElementById('aiPanelSheet').addEventListener('click', (e) => {
            const btn = e.target.closest('.quick-action-btn');
            if (btn) this.handleQuickAction({ currentTarget: btn });
        });

        this.askBtn.addEventListener('click', () => this.handleAskQuestion());
        this.questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) this.handleAskQuestion(); });
        document.getElementById('aiSheetClose').addEventListener('click', () => this.closeAIPanel());

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

        // AI sheet handle drag to close
        this.initAISheetDrag();

        // Reading content click to toggle toolbars
        document.getElementById('readingContent').addEventListener('click', (e) => {
            if (e.target.closest('.reading-toolbar') || e.target.closest('.ai-panel-sheet') || e.target.closest('.toc-drawer')) return;
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
                        <button class="book-action-btn delete-btn">删除</button>
                    </div>
                </div>`;
        }).join('');

        booksGrid.querySelectorAll('.book-card').forEach(card => {
            const bookId = card.dataset.bookId;
            card.querySelector('.read-btn').addEventListener('click', (e) => { e.stopPropagation(); this.openBook(bookId); });
            card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); this.deleteBook(bookId); });
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
        const sheet = document.getElementById('aiPanelSheet');
        if (sheet.classList.contains('open')) {
            this.closeAIPanel();
        } else {
            sheet.classList.add('open');
            document.getElementById('aiFab').classList.add('hidden');
        }
    }

    closeAIPanel() {
        document.getElementById('aiPanelSheet').classList.remove('open');
        document.getElementById('aiFab').classList.remove('hidden');
    }

    openAIPanel() {
        if (this.selectedText) {
            document.getElementById('selectedTextBox').style.display = 'block';
            this.selectedTextContent.textContent = this.selectedText;
        }
        document.getElementById('aiPanelSheet').classList.add('open');
        document.getElementById('aiFab').classList.add('hidden');
        this.questionInput.focus();
    }

    initAISheetDrag() {
        const sheet = document.getElementById('aiPanelSheet');
        const handle = document.getElementById('aiSheetHandle');
        let startY = 0, currentY = 0, dragging = false;

        handle.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; dragging = true; }, { passive: true });
        handle.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            currentY = e.touches[0].clientY - startY;
            if (currentY > 0) sheet.style.transform = `translateY(${currentY}px)`;
        }, { passive: true });
        handle.addEventListener('touchend', () => {
            dragging = false;
            sheet.style.transform = '';
            if (currentY > 100) this.closeAIPanel();
            currentY = 0;
        }, { passive: true });
    }

    // ==================== Text Selection & AI ====================

    handleTextSelection(e) {
        if (this.floatingToolbar.contains(e.target) || document.getElementById('aiPanelSheet').contains(e.target)) return;
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
        if (!this.floatingToolbar.contains(e.target) && !document.getElementById('aiPanelSheet').contains(e.target)) {
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
        this.openAIPanel();
        await this.askAI(actionMap[action] || action);
    }

    async handleAskQuestion() {
        const question = this.questionInput.value.trim();
        if (!question) { this.showToast('请输入问题'); return; }
        if (!this.selectedText) { this.showToast('请先选中文本'); return; }
        if (!this.isProviderConfigured()) { this.showModal(); return; }
        await this.askAI(question);
    }

    async askAI(question) {
        this.askBtn.classList.add('loading');
        this.askBtn.disabled = true;
        this.responseContent.innerHTML = '<p class="placeholder-text">AI正在思考中...</p>';

        try {
            const response = await this.apiFetch('/api/ask-stream', {
                method: 'POST',
                body: JSON.stringify({
                    text: this.selectedText, question, bookName: this.getCurrentBookName(),
                    provider: this.currentProvider, model: this.currentModel
                })
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.needApiKey) {
                    const pi = this.providers.find(p => p.id === (data.provider || this.currentProvider));
                    this.responseContent.innerHTML = `<div class="api-warning"><span class="api-warning-icon">⚠️</span><div class="api-warning-text"><strong>需要配置API密钥</strong>请先配置${pi ? pi.name : 'AI'}的API密钥</div></div>`;
                    this.checkApiKeyStatus();
                } else {
                    this.responseContent.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(data.error)}</p>`;
                }
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', fullContent = '', pendingChunk = '', rafId = null;
            this.responseContent.innerHTML = '';

            const flushChunk = (el) => {
                if (!pendingChunk || !el) return;
                const text = pendingChunk;
                pendingChunk = '';
                const parts = text.split('\n');
                parts.forEach((part, i) => {
                    if (part) el.appendChild(document.createTextNode(part));
                    if (i < parts.length - 1) el.appendChild(document.createElement('br'));
                });
                el.scrollTop = el.scrollHeight;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (rafId) cancelAnimationFrame(rafId);
                    flushChunk(this.responseContent.querySelector('.answer-content'));
                    break;
                }
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
                                const rh = document.querySelector('#aiPanelSheet .response-header');
                                if (rh) rh.innerHTML = `<span class="response-label">AI回答：</span><span class="model-tag-inline">${parsed.provider} · ${parsed.model}</span>`;
                                this.responseContent.innerHTML = '<div class="answer-content"></div>';
                            } else if (parsed.type === 'chunk') {
                                fullContent += parsed.content;
                                pendingChunk += parsed.content;
                                if (!rafId) {
                                    rafId = requestAnimationFrame(() => {
                                        rafId = null;
                                        flushChunk(this.responseContent.querySelector('.answer-content'));
                                    });
                                }
                            } else if (parsed.type === 'end') {
                                this.saveToHistory(this.selectedText, question, fullContent);
                            } else if (parsed.type === 'error') {
                                this.responseContent.innerHTML = `<p style="color:#ef4444;">错误: ${this.escapeHtml(parsed.error)}</p>`;
                            }
                        } catch {}
                    }
                }
            }
        } catch {
            this.responseContent.innerHTML = '<p style="color:#ef4444;">网络错误</p>';
        } finally {
            this.askBtn.classList.remove('loading');
            this.askBtn.disabled = false;
            this.questionInput.value = '';
        }
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
        document.getElementById('customProvidersSection').style.display = 'block';
        document.getElementById('addProviderForm').style.display = 'block';
        this.renderCustomProvidersList();
        this.checkApiKeyStatus();
    }

    showCustomProviderSettings(providerId) {
        const pi = this.providers.find(p => p.id === providerId);
        if (!pi) return;
        this.currentProvider = providerId;
        this.currentModel = localStorage.getItem(`selectedModel_${providerId}`) || null;
        localStorage.setItem('selectedProvider', providerId);
        this.providerTabs.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === 'custom'));
        document.querySelector('.api-key-form').style.display = 'block';
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
        const item = { id: Date.now(), text: selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : ''), question, answer, time: new Date().toLocaleString('zh-CN') };
        this.history.unshift(item);
        if (this.history.length > 50) this.history = this.history.slice(0, 50);
        this.renderHistory();
        try { await this.apiFetch('/api/history', { method: 'POST', body: JSON.stringify({ text: selectedText, question, answer }) }); } catch {}
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
                time: h.time ? new Date(h.time).toLocaleString('zh-CN') : ''
            }));
        } catch { this.history = []; }
        this.renderHistory();
    }

    renderHistory() {
        if (!this.history.length) { this.historyList.innerHTML = '<p class="empty-history">暂无历史记录</p>'; return; }
        this.historyList.innerHTML = this.history.map(item =>
            `<div class="history-item"><div class="history-selected-text">${this.escapeHtml(item.text)}</div><div class="history-question">${this.escapeHtml(item.question)}</div><div class="history-answer">${this.escapeHtml(item.answer.substring(0, 300))}${item.answer.length > 300 ? '...' : ''}</div><div class="history-time">${item.time}</div></div>`
        ).join('');
    }

    async clearHistory() {
        if (!confirm('确定清空所有历史记录吗？')) return;
        this.history = [];
        this.renderHistory();
        try { await this.apiFetch('/api/history', { method: 'DELETE' }); } catch {}
        this.showToast('历史记录已清空');
    }

    // ==================== Keyboard ====================

    handleKeyboardShortcuts(e) {
        if (e.ctrlKey && e.key === 'Enter' && document.getElementById('aiPanelSheet').classList.contains('open')) this.handleAskQuestion();
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
