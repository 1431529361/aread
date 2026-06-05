// 极简状态容器：使用订阅模式，模块间共享状态
// 避免引入 Redux/MobX 等额外依赖

class Store {
    constructor(initialState = {}) {
        this.state = { ...initialState };
        this.listeners = new Set();
    }

    get(key) {
        return key === undefined ? this.state : this.state[key];
    }

    set(patch) {
        const prev = this.state;
        this.state = { ...prev, ...patch };
        for (const listener of this.listeners) {
            listener(this.state, prev);
        }
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

// 全局应用状态
export const store = new Store({
    // 认证
    token: localStorage.getItem('authToken') || null,
    user: null,
    isAuthenticated: !!localStorage.getItem('authToken'),

    // AI 提供商
    providers: [],          // 服务端返回的列表
    apiProviders: {},       // 密钥状态 {providerId: {hasKey, maskedKey, lastUpdated}}
    currentProvider: localStorage.getItem('selectedProvider') || 'zhipu',
    currentModel: localStorage.getItem(`selectedModel_${localStorage.getItem('selectedProvider') || 'zhipu'}`) || null,

    // 书架
    books: [],
    uploadedFileName: null,

    // 选中文本
    selectedText: '',

    // 历史记录
    history: []
});

// token 变更时自动持久化
store.subscribe((state, prev) => {
    if (state.token !== prev.token) {
        if (state.token) localStorage.setItem('authToken', state.token);
        else localStorage.removeItem('authToken');
    }
    if (state.currentProvider !== prev.currentProvider) {
        localStorage.setItem('selectedProvider', state.currentProvider);
    }
    if (state.currentModel !== prev.currentModel && state.currentProvider) {
        localStorage.setItem(`selectedModel_${state.currentProvider}`, state.currentModel || '');
    }
});
