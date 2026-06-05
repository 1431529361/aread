// 后端 API 客户端：所有 fetch 调用集中在此

import { store } from './store.js';

class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = store.get('token');
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }

    const response = await fetch(url, { ...options, headers, body });

    if (response.status === 401) {
        // token 过期或失效
        store.set({ token: null, user: null, isAuthenticated: false });
        throw new ApiError('登录已过期', 401, null);
    }

    let data = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        data = await response.json().catch(() => null);
    } else if (response.body) {
        data = await response.text();
    }

    if (!response.ok) {
        const message = (data && data.error) || `HTTP ${response.status}`;
        throw new ApiError(message, response.status, data);
    }

    return data;
}

// ==================== 认证 ====================
export const auth = {
    register: (username, password) =>
        request('/api/auth/register', { method: 'POST', body: { username, password } }),
    login: (username, password, rememberMe = false) =>
        request('/api/auth/login', { method: 'POST', body: { username, password, rememberMe } }),
    me: () => request('/api/auth/me')
};

// ==================== AI 提供商 ====================
export const providers = {
    list: () => request('/api/providers'),
    add: (payload) => request('/api/providers', { method: 'POST', body: payload }),
    update: (id, payload) => request(`/api/providers/${id}`, { method: 'PUT', body: payload }),
    remove: (id) => request(`/api/providers/${id}`, { method: 'DELETE' })
};

// ==================== API 密钥 ====================
export const keys = {
    status: () => request('/api/key/status'),
    set: (apiKey, provider) => request('/api/key/set', { method: 'POST', body: { apiKey, provider } }),
    verify: (provider, apiKey) => request('/api/key/verify', {
        method: 'POST',
        body: apiKey ? { provider, apiKey } : { provider }
    }),
    remove: (provider) => request('/api/key', { method: 'DELETE', body: { provider } })
};

// ==================== 书籍 ====================
export const books = {
    list: () => request('/api/books'),
    get: (id) => request(`/api/books/${id}`),
    remove: (id) => request(`/api/books/${id}`, { method: 'DELETE' }),
    setProgress: (id, progress) => request(`/api/books/${id}/progress`, {
        method: 'PUT',
        body: { progress }
    }),
    // 上传用 XHR 单独处理以支持进度条
    upload(file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            });
            xhr.addEventListener('load', () => {
                if (xhr.status === 401) {
                    store.set({ token: null, user: null, isAuthenticated: false });
                    reject(new ApiError('登录已过期', 401, null));
                    return;
                }
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300) resolve(data);
                    else reject(new ApiError(data.error || `HTTP ${xhr.status}`, xhr.status, data));
                } catch (e) {
                    reject(new ApiError('响应解析失败', xhr.status, null));
                }
            });
            xhr.addEventListener('error', () => reject(new ApiError('网络错误', 0, null)));
            const formData = new FormData();
            formData.append('book', file);
            xhr.open('POST', '/api/books/upload');
            const token = store.get('token');
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.send(formData);
        });
    },
    downloadUrl: (id) => `/api/books/${id}/download`
};

// ==================== AI 问答 ====================
export const ai = {
    // 非流式
    ask: (payload) => request('/api/ask', { method: 'POST', body: payload }),

    // 流式（SSE）：返回 { response, cancel }
    askStream(payload, onEvent) {
        const controller = new AbortController();
        const promise = (async () => {
            const token = store.get('token');
            const response = await fetch('/api/ask-stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            if (!response.ok) {
                let data = null;
                try { data = await response.json(); } catch (_) {}
                if (response.status === 401) {
                    store.set({ token: null, user: null, isAuthenticated: false });
                }
                throw new ApiError(data?.error || `HTTP ${response.status}`, response.status, data);
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
                    const dataStr = line.slice(6).trim();
                    if (!dataStr) continue;
                    try {
                        const parsed = JSON.parse(dataStr);
                        onEvent(parsed);
                    } catch (_) {}
                }
            }
        })();
        return { promise, cancel: () => controller.abort() };
    }
};

// ==================== 历史记录 ====================
export const history = {
    list: () => request('/api/history'),
    add: (text, question, answer) => request('/api/history', {
        method: 'POST',
        body: { text, question, answer }
    }),
    remove: (id) => request('/api/history', {
        method: 'DELETE',
        body: id ? { id } : {}
    })
};

export { ApiError };
