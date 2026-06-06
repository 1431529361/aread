// 认证 UI：登录、注册、退出、token 验证

import { auth } from './api.js';
import { store } from './store.js';
import { $id, showToast } from './utils.js';

let onAuthenticated = null; // 登录成功后的回调，由 main 注入

export function initAuth(callback) {
    onAuthenticated = callback;

    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    $id('authForm').addEventListener('submit', handleSubmit);
    $id('logoutBtn').addEventListener('click', logout);

    if (store.get('token')) {
        validateToken();
    } else {
        showAuthScreen();
    }
}

function switchTab(mode) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === mode));
    $id('rememberMeGroup').style.display = mode === 'login' ? 'flex' : 'none';
    $id('authSubmitBtn').querySelector('.btn-text').textContent = mode === 'login' ? '登录' : '注册';
    $id('authError').textContent = '';
    $id('authForm').dataset.mode = mode;
}

async function handleSubmit(e) {
    e.preventDefault();
    const mode = $id('authForm').dataset.mode || 'login';
    const username = $id('authUsername').value.trim();
    const password = $id('authPassword').value;
    const rememberMe = $id('rememberMe').checked;
    const errorEl = $id('authError');
    const submitBtn = $id('authSubmitBtn');

    if (!username) { errorEl.textContent = '请输入用户名'; return; }
    if (!password || password.length < 6) { errorEl.textContent = '密码至少6位'; return; }

    errorEl.textContent = '';
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    try {
        const data = mode === 'login'
            ? await auth.login(username, password, rememberMe)
            : await auth.register(username, password);

        store.set({
            token: data.token,
            user: data.user,
            isAuthenticated: true
        });
        hideAuthScreen();
        onAuthenticated && onAuthenticated();
    } catch (err) {
        errorEl.textContent = err.message || '操作失败';
    } finally {
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
    }
}

export function showAuthScreen() {
    $id('authOverlay').classList.add('visible');
    $id('userInfo').style.display = 'none';
}

export function hideAuthScreen() {
    $id('authOverlay').classList.remove('visible');
    if (store.get('user')) {
        $id('displayUsername').textContent = store.get('user').username;
        $id('userInfo').style.display = 'flex';
    }
}

export function logout() {
    store.set({ token: null, user: null, isAuthenticated: false, history: [], books: [] });
    showAuthScreen();
    showToast('已退出登录');
}

async function validateToken() {
    try {
        const data = await auth.me();
        store.set({ user: data.user, isAuthenticated: true });
        hideAuthScreen();
        onAuthenticated && onAuthenticated();
    } catch (err) {
        // token 无效，回到登录页
        store.set({ token: null, user: null, isAuthenticated: false });
        showAuthScreen();
    }
}
