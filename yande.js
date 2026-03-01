// ==UserScript==
// @name         Yande 全屏浏览器7.1（排序+收藏）
// @namespace    https://yande.re/
// @version      7.1
// @match        https://yande.re/post*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/**
 * Yande 全屏浏览器脚本
 * 功能：
 * 1. 在 Yande.re 网站上添加全屏浏览器功能
 * 2. 支持按默认、评分、收藏数排序
 * 3. 支持收藏功能和状态同步
 * 4. 支持深色/浅色主题切换
 * 5. 支持自定义网格列数
 * 6. 支持键盘快捷键导航
 */

/**
 * 获取 CSRF 令牌
 * @returns {string|null} CSRF 令牌值，如果未找到则返回 null
 * @description 用于获取页面中的 CSRF 令牌，用于收藏操作等需要身份验证的请求
 */
function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content;
}

(function () {
    'use strict';
    // 只在 post 页面运行脚本
    if (!location.pathname.startsWith('/post')) return;

    // 核心变量定义
    let overlay = null; // 全屏浏览器覆盖层
    let viewer = null; // 图片查看器

    // 分页和加载相关变量
    let currentBatch = 0; // 当前批次
    let pagePerBatch = 3; // 每批加载的页数
    let limitPerPage = 20; // 每页的帖子数量
    let totalLoaded = 0; // 已加载的帖子总数
    let minScore = 0; // 最低评分过滤

    // 网格和主题相关常量
    const GRID_COLS_STORAGE_KEY = 'yande.gridColumns'; // 网格列数存储键
    const THEME_STORAGE_KEY = 'yande.themeMode'; // 主题模式存储键
    const CARD_IMAGE_MODE_STORAGE_KEY = 'yande.cardImageMode'; // 卡片图片模式存储键
    const DEFAULT_GRID_COLUMNS = 4; // 默认网格列数
    const MIN_GRID_COLUMNS = 1; // 最小网格列数
    const MAX_GRID_COLUMNS = 12; // 最大网格列数
    const MIN_CARD_WIDTH = 340; // 卡片最小宽度
    const MIN_COLUMNS_ON_NARROW = 2; // 窄屏最小列数

    // 用户偏好设置
    let preferredColumns = readStoredGridColumns(); // 首选网格列数
    let themeMode = readStoredThemeMode(); // 主题模式
    let cardImageMode = readStoredCardImageMode(); // 卡片图片模式

    // 帖子和查看器相关变量
    let loadedPosts = []; // 已加载的帖子数组
    let loadedPostMap = new Map(); // 已加载帖子映射（id -> post）
    let currentIndex = 0; // 当前查看的帖子索引
    let overlayContent = null; // 覆盖层内容区域
    let overlayLoadBtn = null; // 加载按钮
    let batchLoadingPromise = null; // 批处理加载 Promise
    let viewerImg = null; // 查看器图片元素
    let viewerStatus = null; // 查看器状态元素
    let viewerFavBtn = null; // 查看器收藏按钮
    let viewerLinkBtn = null; // 查看器链接按钮
    let viewerSizeInfo = null; // 查看器尺寸信息
    let lastWheelAt = 0; // 上次滚轮事件时间戳

    // 排序相关
    let sortType = '1'; // 排序类型，1=默认，2=评分，3=收藏数

    // 排序选项
    const data = [
        { value: '1', text: '默认' },
        { value: '2', text: '评分' },
        { value: '3', text: '收藏数' }
    ];

    // 收藏状态相关
    const FAV_STATE_STORAGE_KEY = 'yande.favoriteStateMap'; // 收藏状态存储键
    const favState = new Set(); // 当前会话内的本地收藏状态
    const persistedFavState = readStoredFavoriteStateMap(); // 从存储读取的收藏状态
    console.log('Loaded favorite state:', persistedFavState);
    hydrateFavStateFromStorage(); // 从存储加载收藏状态到内存
    const onOverlayResize = () => refreshAllGridColumns(); // 覆盖层 resize 事件处理函数

    /**
     * 规范化网格列数
     * @param {number|string} value - 输入的列数
     * @param {number} fallback - 当输入无效时的默认值，默认为 DEFAULT_GRID_COLUMNS
     * @returns {number} 规范化后的列数，确保在 MIN_GRID_COLUMNS 和 MAX_GRID_COLUMNS 之间
     * @description 用于确保网格列数在合理范围内，防止输入无效值
     */
    function normalizeGridColumns(value, fallback = DEFAULT_GRID_COLUMNS) {
        const parsed = Math.floor(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(MAX_GRID_COLUMNS, Math.max(MIN_GRID_COLUMNS, parsed));
    }

    /**
     * 从存储中读取网格列数设置
     * @returns {number} 存储的网格列数，如果读取失败则返回 DEFAULT_GRID_COLUMNS
     * @description 用于从 GM 存储中读取用户设置的网格列数，并进行规范化处理
     */
    function readStoredGridColumns() {
        try {
            const raw = GM_getValue(GRID_COLS_STORAGE_KEY, DEFAULT_GRID_COLUMNS);
            return normalizeGridColumns(raw, DEFAULT_GRID_COLUMNS);
        } catch (e) {
            return DEFAULT_GRID_COLUMNS;
        }
    }

    /**
     * 保存网格列数设置到存储中
     * @param {number|string} columns - 要保存的列数
     * @description 用于将用户设置的网格列数保存到 GM 存储中，并进行规范化处理
     */
    function saveGridColumns(columns) {
        try {
            GM_setValue(GRID_COLS_STORAGE_KEY, normalizeGridColumns(columns, DEFAULT_GRID_COLUMNS));
        } catch (e) {
            // 忽略存储错误
        }
    }

    /**
     * 规范化主题模式
     * @param {string} value - 输入的主题模式
     * @returns {string} 规范化后的主题模式，只能是 'dark' 或 'light'
     * @description 用于确保主题模式值为有效的 'dark' 或 'light'
     */
    function normalizeThemeMode(value) {
        return value === 'dark' ? 'dark' : 'light';
    }

    /**
     * 从存储中读取主题模式设置
     * @returns {string} 存储的主题模式，如果读取失败则返回 'light'
     * @description 用于从 GM 存储中读取用户设置的主题模式，并进行规范化处理
     */
    function readStoredThemeMode() {
        try {
            return normalizeThemeMode(GM_getValue(THEME_STORAGE_KEY, 'light'));
        } catch (e) {
            return 'light';
        }
    }

    /**
     * 保存主题模式设置到存储中
     * @param {string} mode - 要保存的主题模式
     * @description 用于将用户设置的主题模式保存到 GM 存储中，并进行规范化处理
     */
    function saveThemeMode(mode) {
        try {
            GM_setValue(THEME_STORAGE_KEY, normalizeThemeMode(mode));
        } catch (e) {
            // 忽略存储错误
        }
    }

    /**
     * 规范化卡片图片模式
     * @param {string} value - 输入的图片模式
     * @returns {string} 规范化后的图片模式，只能是 'preview' 或 'thumb'
     */
    function normalizeCardImageMode(value) {
        return value === 'thumb' ? 'thumb' : 'preview';
    }

    /**
     * 从存储中读取卡片图片模式
     * @returns {string} 存储的卡片图片模式，如果读取失败则返回 'preview'
     */
    function readStoredCardImageMode() {
        try {
            return normalizeCardImageMode(GM_getValue(CARD_IMAGE_MODE_STORAGE_KEY, 'preview'));
        } catch (e) {
            return 'preview';
        }
    }

    /**
     * 保存卡片图片模式到存储中
     * @param {string} mode - 要保存的图片模式
     */
    function saveCardImageMode(mode) {
        try {
            GM_setValue(CARD_IMAGE_MODE_STORAGE_KEY, normalizeCardImageMode(mode));
        } catch (e) {
            // 忽略存储错误
        }
    }

    /**
     * 获取卡片应该展示的图片 URL
     * @param {Object} post - 帖子对象
     * @returns {string} 图片 URL
     */
    function getCardImageUrl(post) {
        if (!post || typeof post !== 'object') return '';
        if (cardImageMode === 'thumb') {
            return post.preview_url || post.sample_url || post.jpeg_url || post.file_url || '';
        }
        return post.sample_url || post.preview_url || post.jpeg_url || post.file_url || '';
    }

    /**
     * 刷新所有已渲染卡片的图片来源
     */
    function refreshAllCardImageSources() {
        if (!overlay) return;
        overlay.querySelectorAll('.yande-card img[data-post-id]').forEach(img => {
            const postId = Number(img.dataset.postId);
            if (!Number.isFinite(postId)) return;
            const post = loadedPostMap.get(postId);
            if (!post) return;
            const nextUrl = getCardImageUrl(post);
            if (!nextUrl) return;
            img.src = nextUrl;
        });
    }

    /**
     * 从存储中读取收藏状态映射
     * @returns {Object} 收藏状态映射，键为帖子 ID，值为布尔值表示是否收藏
     * @description 用于从 GM 存储中读取用户的收藏状态，并进行清理和验证
     */
    function readStoredFavoriteStateMap() {
        try {
            const raw = GM_getValue(FAV_STATE_STORAGE_KEY, {});
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
            const cleaned = {};
            for (const [id, value] of Object.entries(raw)) {
                cleaned[id] = !!value;
            }
            return cleaned;
        } catch (e) {
            console.error('读取收藏状态失败:', e);
            return {};
        }
    }

    /**
     * 从存储中加载收藏状态到内存中
     * @description 用于将存储中的收藏状态加载到内存中的 favState Set 中
     */
    function hydrateFavStateFromStorage() {
        for (const [id, value] of Object.entries(persistedFavState)) {
            const numericId = Number(id);
            if (!Number.isFinite(numericId)) continue;
            if (value) {
                favState.add(numericId);
            } else {
                favState.delete(numericId);
            }
        }
    }

    /**
     * 持久化收藏状态到存储中
     * @param {number|string} postId - 帖子 ID
     * @param {boolean} state - 收藏状态，true 表示收藏，false 表示取消收藏
     * @param {string} source - 操作来源，默认为 'unknown'
     * @description 用于更新内存中的收藏状态并持久化到 GM 存储中
     */
    function persistFavoriteState(postId, state, source = 'unknown') {
        const normalizedId = Number(postId);
        if (!Number.isFinite(normalizedId)) return;

        if (state) {
            favState.add(normalizedId);
        } else {
            favState.delete(normalizedId);
        }

        persistedFavState[String(normalizedId)] = !!state;
        syncFavoriteUIForPost(normalizedId, !!state);

        try {
            GM_setValue(FAV_STATE_STORAGE_KEY, persistedFavState);
            console.log(`[YandeFavSync] 帖子 ${normalizedId} 收藏状态已更新为 ${state ? '已收藏' : '未收藏'}（来源：${source}）`);
        } catch (e) {
            console.error(`[YandeFavSync] 保存帖子 ${normalizedId} 收藏状态失败:`, e);
        }
    }

    /**
     * 批量持久化收藏状态到存储中
     * @param {Array<number|string>} postIds - 帖子 ID 列表
     * @param {boolean} state - 收藏状态
     * @param {string} source - 操作来源
     */
    function persistFavoriteStateBulk(postIds, state, source = 'unknown') {
        if (!Array.isArray(postIds) || !postIds.length) return;

        const normalizedIds = [];
        for (const postId of postIds) {
            const normalizedId = Number(postId);
            if (!Number.isFinite(normalizedId)) continue;
            normalizedIds.push(normalizedId);
            if (state) {
                favState.add(normalizedId);
            } else {
                favState.delete(normalizedId);
            }
            persistedFavState[String(normalizedId)] = !!state;
            syncFavoriteUIForPost(normalizedId, !!state);
        }

        if (!normalizedIds.length) return;
        try {
            GM_setValue(FAV_STATE_STORAGE_KEY, persistedFavState);
            console.log(`[YandeFavSync] 已批量更新 ${normalizedIds.length} 个帖子收藏状态为 ${state ? '已收藏' : '未收藏'}（来源：${source}）`);
        } catch (e) {
            console.error(`[YandeFavSync] 批量保存收藏状态失败（来源：${source}）:`, e);
        }
    }

    /**
     * 判断是否为“我的收藏列表”查询
     * @param {string} tags - 标签字符串
     * @returns {boolean} 是否应自动将返回结果写入收藏状态
     */
    function shouldAutoPersistFavoriteIds(tags) {
        const normalizedTags = String(tags || '').toLowerCase();
        const tokens = normalizedTags.split(/\s+/).filter(Boolean);
        return tokens.includes('vote:3:aglsv')
    }

    /**
     * 检查是否为帖子详情页
     * @param {string} pathname - 路径名，默认为当前页面路径
     * @returns {boolean} 是否为帖子详情页
     * @description 用于判断当前页面是否为帖子详情页，以便进行相应的收藏状态初始化和监听
     */
    function isPostShowPage(pathname = location.pathname) {
        return /^\/post\/show\/\d+/.test(pathname);
    }

    /**
     * 从路径中获取当前帖子 ID
     * @param {string} pathname - 路径名，默认为当前页面路径
     * @returns {number|null} 帖子 ID，如果不是帖子详情页则返回 null
     * @description 用于从 URL 路径中提取帖子 ID，用于收藏操作等
     */
    function getCurrentPostIdFromPath(pathname = location.pathname) {
        const match = pathname.match(/^\/post\/show\/(\d+)/);
        if (!match) return null;
        const postId = Number(match[1]);
        return Number.isFinite(postId) ? postId : null;
    }

    /**
     * 从元素中获取收藏操作类型
     * @param {Element} el - 元素
     * @returns {boolean|null} 收藏操作类型，true 表示点击后将收藏，false 表示点击后将取消收藏，null 表示无法识别
     * @description 用于分析收藏按钮的文本和属性，确定点击后的目标状态（不是当前状态）
     */
    function getFavoriteActionFromElement(el) {
        if (!el) return null;

        const textSegments = [
            el.textContent,
            el.value,
            el.title,
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('data-action'),
            el.getAttribute?.('href')
        ].filter(Boolean).join(' ').toLowerCase();

        if (!textSegments) return null;

        if (/remove|unfav|取消收藏|取消\s*收藏|移除|从收藏中移除|delete\s*fav/.test(textSegments)) return false;
        if (/add|favorite|favourite|收藏/.test(textSegments)) return true;

        return null;
    }

    /**
     * 判断元素在页面中是否可见
     * @param {Element|null} el - 元素
     * @returns {boolean} 是否可见
     */
    function isElementVisible(el) {
        if (!(el instanceof Element)) return false;
        let current = el;
        while (current && current !== document.documentElement) {
            const style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
                return false;
            }
            current = current.parentElement;
        }
        return true;
    }

    /**
     * 从元素中推断当前收藏状态
     * @param {Element} el - 元素
     * @returns {boolean|null} 当前收藏状态，true 表示已收藏，false 表示未收藏，null 表示无法识别
     * @description 收藏控件通常显示的是“下一步动作”，因此当前状态等于动作取反
     */
    function getCurrentFavoriteStateFromElement(el) {
        const action = getFavoriteActionFromElement(el);
        if (action === null) return null;
        return !action;
    }

    /**
     * 从详情页收藏按钮容器的显隐读取当前收藏状态
     * @returns {boolean|null} 当前收藏状态，true 表示已收藏，false 表示未收藏
     */
    function getCurrentFavoriteStateFromToggleControls() {
        const removeNode = document.querySelector('#remove-from-favs');
        const addNode = document.querySelector('#add-to-favs');
        const hasToggleNodes = !!removeNode || !!addNode;
        if (!hasToggleNodes) return null;

        const removeVisible = isElementVisible(removeNode);
        const addVisible = isElementVisible(addNode);

        if (removeVisible && !addVisible) return true;
        if (addVisible && !removeVisible) return false;
        return null;
    }

    /**
     * 在页面中查找收藏控件
     * @returns {Element|null} 收藏控件元素，如果未找到则返回 null
     * @description 用于在页面中查找收藏按钮或链接，以便进行收藏状态初始化和监听
     */
    function findFavoriteControlInPage() {
        const selectors = [
            '#remove-from-favs a',
            '#remove-from-favs input[type="submit"]',
            '#remove-from-favs button',
            '#add-to-favs a',
            '#add-to-favs input[type="submit"]',
            '#add-to-favs button',
            'a[href*="/post/vote"]',
            'form[action*="/post/vote"] input[type="submit"]',
            'form[action*="/post/vote"] button'
        ];

        let fallbackMatched = null;
        for (const selector of selectors) {
            const candidates = document.querySelectorAll(selector);
            for (const node of candidates) {
                if (getFavoriteActionFromElement(node) === null) continue;
                if (isElementVisible(node)) return node;
                if (!fallbackMatched) fallbackMatched = node;
            }
        }

        return fallbackMatched;
    }

    /**
     * 等待收藏控件出现
     * @param {number} timeoutMs - 超时时间，默认为 12000 毫秒
     * @returns {Promise<Element|null>} 收藏控件元素，如果超时则返回 null
     * @description 用于等待页面加载完成后收藏控件出现，以便进行收藏状态初始化
     */
    function waitForFavoriteControl(timeoutMs = 12000) {
        return new Promise(resolve => {
            const immediate = findFavoriteControlInPage();
            if (immediate) {
                resolve(immediate);
                return;
            }

            const observer = new MutationObserver(() => {
                const matched = findFavoriteControlInPage();
                if (!matched) return;
                observer.disconnect();
                resolve(matched);
            });

            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
        });
    }

    /**
     * 初始化帖子详情页的收藏状态
     * @description 用于在帖子详情页加载时初始化收藏状态，确保本地收藏状态与服务器状态同步
     */
    function initializeFavoriteStateForPostPage() {
        if (!isPostShowPage()) return;

        const postId = getCurrentPostIdFromPath();
        if (!postId) return;

        const run = async () => {
            try {
                const control = await waitForFavoriteControl();
                if (!control) {
                    console.warn(`[YandeFavSync] 未找到帖子 ${postId} 的收藏按钮，跳过初始化。`);
                    return;
                }

                const currentFavoriteState = getCurrentFavoriteStateFromToggleControls() ?? getCurrentFavoriteStateFromElement(control);
                if (currentFavoriteState === null) {
                    console.warn(`[YandeFavSync] 无法识别帖子 ${postId} 收藏按钮状态。`);
                    return;
                }

                persistFavoriteState(postId, currentFavoriteState, 'page-load');
            } catch (e) {
                console.error(`[YandeFavSync] 初始化帖子 ${postId} 收藏状态失败:`, e);
            }
        };

        if (document.readyState === 'complete') {
            setTimeout(() => void run(), 0);
        } else {
            window.addEventListener('load', () => void run(), { once: true });
        }
    }

    /**
     * 从点击目标查找收藏控件
     * @param {EventTarget} target - 点击目标
     * @returns {Element|null} 收藏控件元素，如果未找到则返回 null
     * @description 用于从点击事件的目标元素向上查找收藏控件，以便处理收藏点击事件
     */
    function findFavoriteControlFromTarget(target) {
        if (!(target instanceof Element)) return null;

        const selectors = [
            '#remove-from-favs a',
            '#remove-from-favs input[type="submit"]',
            '#remove-from-favs button',
            '#add-to-favs a',
            '#add-to-favs input[type="submit"]',
            '#add-to-favs button',
            'a[href*="/post/vote"]',
            'form[action*="/post/vote"] input[type="submit"]',
            'form[action*="/post/vote"] button'
        ];

        for (const selector of selectors) {
            const matched = target.closest(selector);
            if (matched) return matched;
        }

        return null;
    }

    /**
     * 为帖子详情页设置收藏点击监听器
     * @description 用于监听帖子详情页的收藏按钮点击事件，实时更新收藏状态
     */
    function setupFavoriteActionListenerForPostPage() {
        if (!isPostShowPage()) return;

        const postId = getCurrentPostIdFromPath();
        if (!postId) return;

        document.addEventListener('click', e => {
            try {
                const control = findFavoriteControlFromTarget(e.target);
                if (!control) return;

                const nextState = getFavoriteActionFromElement(control);
                if (nextState === null) {
                    console.warn(`[YandeFavSync] 点击收藏控件但未能识别动作，帖子 ${postId}`);
                    return;
                }

                persistFavoriteState(postId, nextState, 'click');

                setTimeout(() => {
                    const latestControl = findFavoriteControlInPage();
                    const latestState = getCurrentFavoriteStateFromToggleControls() ?? getCurrentFavoriteStateFromElement(latestControl);
                    if (latestState !== null) {
                        persistFavoriteState(postId, latestState, 'post-click-refresh');
                    }
                }, 300);
            } catch (err) {
                console.error(`[YandeFavSync] 监听收藏点击失败，帖子 ${postId}:`, err);
            }
        }, true);
    }

    /**
     * 获取主题调色板
     * @returns {Object} 主题颜色配置对象
     * @description 根据当前主题模式返回对应的颜色配置，用于应用主题样式
     */
    function getThemePalette() {
        if (themeMode === 'dark') {
            return {
                overlayBg: '#0f1115',
                text: '#e5e7eb',
                headerBg: 'rgba(24,28,36,0.92)',
                headerBorder: '#2b3240',
                headerShadow: '0 2px 12px rgba(0,0,0,0.35)',
                controlBg: '#141923',
                controlBorder: '#2e3544',
                controlText: '#e5e7eb',
                secondaryBtnBg: '#374151',
                mutedText: '#9ca3af',
                titleText: '#f3f4f6',
                cardBg: '#1a1f2b',
                cardShadow: '0 3px 14px rgba(0,0,0,0.45)',
                cardHoverShadow: '0 14px 28px rgba(0,0,0,0.55)',
                favCardBg: '#7f1d1d',
                favCardBorder: '#ef4444',
                favCardShadow: '0 3px 14px rgba(127,29,29,0.55)',
                favCardHoverShadow: '0 14px 28px rgba(239,68,68,0.45)',
                mediaBg: '#111827',
                badgeBg: 'rgba(15,23,42,0.82)',
                viewerBg: 'rgba(0,0,0,0.88)'
            };
        }
        return {
            overlayBg: '#f6f7f8',
            text: '#111827',
            headerBg: 'rgba(255,255,255,0.92)',
            headerBorder: '#e5e7eb',
            headerShadow: '0 2px 12px rgba(17,24,39,0.06)',
            controlBg: '#ffffff',
            controlBorder: '#e5e7eb',
            controlText: '#111827',
            secondaryBtnBg: '#111827',
            mutedText: '#374151',
            titleText: '#111827',
            cardBg: '#ffffff',
            cardShadow: '0 3px 14px rgba(0,0,0,0.08)',
            cardHoverShadow: '0 14px 28px rgba(17,24,39,0.14)',
            favCardBg: '#ef4444',
            favCardBorder: '#b91c1c',
            favCardShadow: '0 3px 14px rgba(185,28,28,0.35)',
            favCardHoverShadow: '0 14px 28px rgba(220,38,38,0.45)',
            mediaBg: '#f3f4f6',
            badgeBg: 'rgba(17,24,39,0.76)',
            viewerBg: 'rgba(15,23,42,0.92)'
        };
    }

    /**
     * 应用卡片收藏状态样式
     * @param {Element} card - 卡片元素
     * @param {boolean} isFav - 是否已收藏
     * @param {Object} themePalette - 主题调色板
     */
    function applyCardFavoriteStyle(card, isFav, themePalette = getThemePalette()) {
        if (!card) return;
        const favorited = !!isFav;
        const normalShadow = favorited ? themePalette.favCardShadow : themePalette.cardShadow;
        const hoverShadow = favorited ? themePalette.favCardHoverShadow : themePalette.cardHoverShadow;

        card.dataset.favorited = favorited ? '1' : '0';
        card.dataset.normalShadow = normalShadow;
        card.dataset.hoverShadow = hoverShadow;
        card.style.background = favorited ? themePalette.favCardBg : themePalette.cardBg;
        card.style.border = favorited ? `2px solid ${themePalette.favCardBorder}` : '2px solid transparent';
        card.style.boxShadow = normalShadow;
    }

    /**
     * 同步指定帖子在当前界面上的收藏 UI
     * @param {number|string} postId - 帖子 ID
     * @param {boolean} state - 收藏状态
     */
    function syncFavoriteUIForPost(postId, state) {
        const normalizedId = Number(postId);
        if (!Number.isFinite(normalizedId)) return;
        const isFav = !!state;
        const themePalette = getThemePalette();

        document.querySelectorAll(`.yande-fav-btn[data-post-id="${normalizedId}"]`).forEach(btn => {
            updateFavUI(btn, isFav);
        });
        document.querySelectorAll(`.yande-card[data-post-id="${normalizedId}"]`).forEach(card => {
            applyCardFavoriteStyle(card, isFav, themePalette);
        });
    }

    /**
     * 应用主题样式
     * @description 根据当前主题模式应用相应的样式到页面元素
     */
    function applyThemeStyles() {
        if (!overlay) return;
        const t = getThemePalette();

        overlay.style.cssText = `
            position:fixed;
            inset:0;
            background:${t.overlayBg};
            z-index:999999;
            display:flex;
            flex-direction:column;
            color:${t.text};
            font-family:"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        `;

        const header = overlay.querySelector('.yande-header');
        if (header) {
            header.style.cssText = `
                position:sticky;
                top:0;
                background:${t.headerBg};
                backdrop-filter:blur(10px);
                padding:12px 16px;
                display:flex;
                gap:10px;
                align-items:center;
                flex-wrap:wrap;
                border-bottom:1px solid ${t.headerBorder};
                box-shadow:${t.headerShadow};
                color:${t.text};
            `;
            header.querySelectorAll('input, select').forEach(el => {
                el.style.cssText = `
                    width:72px;
                    height:34px;
                    border:1px solid ${t.controlBorder};
                    border-radius:12px;
                    padding:0 10px;
                    background:${t.controlBg};
                    color:${t.controlText};
                    outline:none;
                `;
            });
            const orderTypeSelect = header.querySelector('#orderTypeSelect');
            if (orderTypeSelect) orderTypeSelect.style.width = '96px';
            const imageModeSelect = header.querySelector('#imageModeSelect');
            if (imageModeSelect) imageModeSelect.style.width = '96px';
            const applyBtnEl = header.querySelector('#applyBtn');
            if (applyBtnEl) {
                applyBtnEl.style.cssText = `
                    height:36px;
                    padding:0 14px;
                    border:none;
                    border-radius:999px;
                    background:#e60023;
                    color:#fff;
                    font-weight:700;
                    cursor:pointer;
                `;
            }
            const closeBtnEl = header.querySelector('#closeBtn');
            if (closeBtnEl) {
                closeBtnEl.style.cssText = `
                    height:36px;
                    padding:0 14px;
                    border:none;
                    border-radius:999px;
                    background:${t.secondaryBtnBg};
                    color:#fff;
                    font-weight:700;
                    cursor:pointer;
                `;
            }
            const themeBtnEl = header.querySelector('#themeToggleBtn');
            if (themeBtnEl) {
                themeBtnEl.textContent = themeMode === 'dark' ? '浅色模式' : '深色模式';
                themeBtnEl.style.cssText = `
                    height:36px;
                    padding:0 14px;
                    border:1px solid ${t.controlBorder};
                    border-radius:999px;
                    background:${t.controlBg};
                    color:${t.controlText};
                    font-weight:700;
                    cursor:pointer;
                `;
            }
            const totalInfoEl = header.querySelector('#totalInfo');
            if (totalInfoEl) {
                totalInfoEl.style.cssText = `
                    margin-left:auto;
                    color:${t.mutedText};
                    font-weight:600;
                `;
            }
        }

        const content = overlay.querySelector('.yande-content');
        if (content) {
            content.style.cssText = `flex:1; overflow:auto; padding:22px; background:${t.overlayBg};`;
        }

        const loadBtn = overlay.querySelector('.yande-load-btn');
        if (loadBtn) {
            loadBtn.style.cssText = `
                margin:40px auto;
                padding:10px 18px;
                display:block;
                border:none;
                border-radius:999px;
                background:#e60023;
                color:#fff;
                font-weight:700;
                cursor:pointer;
                box-shadow:0 8px 20px rgba(230,0,35,0.24);
            `;
        }

        overlay.querySelectorAll('.yande-batch-title').forEach(title => {
            title.style.cssText = `
                margin:10px 0 18px 6px;
                color:${t.titleText};
                font-size:20px;
                font-weight:800;
            `;
        });

        overlay.querySelectorAll('.yande-card').forEach(card => {
            const postId = Number(card.dataset.postId);
            const isFav = Number.isFinite(postId) ? favState.has(postId) : card.dataset.favorited === '1';
            applyCardFavoriteStyle(card, isFav, t);
            card.onmouseenter = () => {
                card.style.transform = 'translateY(-3px)';
                card.style.boxShadow = card.dataset.hoverShadow || t.cardHoverShadow;
            };
            card.onmouseleave = () => {
                card.style.transform = 'translateY(0)';
                card.style.boxShadow = card.dataset.normalShadow || t.cardShadow;
            };
        });

        overlay.querySelectorAll('.yande-card img').forEach(img => {
            if (!img.closest('.yande-viewer')) img.style.background = t.mediaBg;
        });

        overlay.querySelectorAll('.yande-score, .yande-fav-btn, .yande-link-btn').forEach(el => {
            el.style.background = t.badgeBg;
            el.style.color = '#fff';
        });

        if (viewer) {
            viewer.style.background = t.viewerBg;
        }
    }

    /**
     * 获取有效的网格列数
     * @param {number} containerWidth - 容器宽度
     * @returns {number} 有效的网格列数
     * @description 根据容器宽度和用户偏好计算有效的网格列数，确保在不同屏幕尺寸下都有良好的显示效果
     */
    function getEffectiveColumns(containerWidth) {
        const width = Math.max(0, Math.floor(containerWidth || 0));
        const allowedByWidth = Math.floor(width / MIN_CARD_WIDTH);
        let effective = Math.min(preferredColumns, allowedByWidth);
        // 窄屏下至少显示 2 列，但用户选择 1 列时不强制提升
        const narrowFloor = Math.min(MIN_COLUMNS_ON_NARROW, preferredColumns);
        effective = Math.max(narrowFloor, effective);
        return Math.max(1, effective);
    }

    /**
     * 应用网格列数
     * @param {Element} grid - 网格元素
     * @description 根据容器宽度应用有效的网格列数
     */
    function applyGridColumns(grid) {
        if (!grid) return;
        const effectiveColumns = getEffectiveColumns(grid.clientWidth || grid.offsetWidth);
        grid.style.gridTemplateColumns = `repeat(${effectiveColumns}, minmax(0, 1fr))`;
    }

    /**
     * 刷新所有网格列数
     * @description 刷新所有网格元素的列数，确保在窗口大小变化时保持良好的显示效果
     */
    function refreshAllGridColumns() {
        if (!overlay) return;
        overlay.querySelectorAll('.yande-fullscreen-grid').forEach(applyGridColumns);
    }

    // ===== 入口按钮 =====
    const openBtn = document.createElement('button');
    openBtn.textContent = '打开全屏浏览器';
    openBtn.style.cssText = `
        position: fixed;
        bottom:20px;
        right:20px;
        z-index:99999;
        padding:10px 18px;
        background:#e60023;
        color:white;
        border:none;
        border-radius:999px;
        cursor:pointer;
        font-weight:700;
        box-shadow:0 10px 24px rgba(230,0,35,0.35);
    `;
    document.body.appendChild(openBtn);
    openBtn.onclick = createOverlay;

    /**
     * 创建全屏浏览器覆盖层
     * @description 创建并显示全屏浏览器覆盖层，用于展示帖子网格
     */
    function createOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed;
            inset:0;
            background:#f6f7f8;
            z-index:999999;
            display:flex;
            flex-direction:column;
            color:#111827;
            font-family:"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        `;
        document.body.appendChild(overlay);
        window.addEventListener('resize', onOverlayResize);
        buildUI();
    }

    /**
     * 关闭全屏浏览器覆盖层
     * @description 关闭并清理全屏浏览器覆盖层
     */
    function closeOverlay() {
        if (!overlay) return;
        window.removeEventListener('resize', onOverlayResize);
        overlay.remove();
        overlay = null;
    }

    // 键盘快捷键
    document.addEventListener('keydown', e => {
        if (viewer) {
            if (e.key === 'ArrowRight') void switchImage(1); // 右箭头键：下一张图片
            if (e.key === 'ArrowLeft') void switchImage(-1); // 左箭头键：上一张图片
            if (e.key === 'Escape') closeViewer(); // ESC键：关闭查看器
        }
    });

    /**
     * 构建用户界面
     * @description 构建全屏浏览器的用户界面，包括头部控制栏、内容区域和加载按钮
     */
    function buildUI() {
        currentBatch = 0;
        totalLoaded = 0;
        loadedPosts = [];
        loadedPostMap.clear();

        const header = document.createElement('div');
        header.className = 'yande-header';
        overlay.appendChild(header);

        const optionsHtml = data.map((item, index) => {
            return `<option value="${item.value}" ${index === 0 ? 'selected' : ''}>${item.text}</option>`;
        }).join('');

        header.innerHTML = `
            起始页 <input id="startPageCount" type="number" value="1" style="width:60px">
            每批页数 <input id="pageCount" type="number" value="1" style="width:60px">
            每页数量 <input id="limitCount" type="number" value="60" style="width:60px">
            图片 <select id="imageModeSelect"><option value="preview">预览图</option><option value="thumb">缩略图</option></select>
            最低评分 <input id="minScoreInput" type="number" value="0" style="width:60px">
            排序 <select id="orderTypeSelect" value="0">${optionsHtml}</select>
            <button id="applyBtn">应用</button>
            <button id="closeBtn">关闭</button>
            <span id="totalInfo">已加载：0</span>
        `;

        const imageModeSelect = header.querySelector('#imageModeSelect');
        if (imageModeSelect) {
            imageModeSelect.value = cardImageMode;
            imageModeSelect.onchange = () => {
                cardImageMode = normalizeCardImageMode(imageModeSelect.value);
                imageModeSelect.value = cardImageMode;
                saveCardImageMode(cardImageMode);
                refreshAllCardImageSources();
            };
        }

        const limitCountInput = header.querySelector('#limitCount');
        if (limitCountInput) {
            limitCountInput.insertAdjacentHTML(
                'afterend',
                ` 列数 <input id="columnCount" type="number" min="${MIN_GRID_COLUMNS}" max="${MAX_GRID_COLUMNS}" value="${preferredColumns}" style="width:60px">`
            );
        }

        const themeToggleBtn = document.createElement('button');
        themeToggleBtn.id = 'themeToggleBtn';
        themeToggleBtn.onclick = () => {
            themeMode = themeMode === 'dark' ? 'light' : 'dark';
            saveThemeMode(themeMode);
            applyThemeStyles();
            refreshAllGridColumns(); // 主题切换时重新计算网格列数
        };

        const totalInfoEl = header.querySelector('#totalInfo');
        if (totalInfoEl) totalInfoEl.insertAdjacentElement('beforebegin', themeToggleBtn);

        document.getElementById('closeBtn').onclick = closeOverlay;

        const content = document.createElement('div');
        content.className = 'yande-content';
        overlay.appendChild(content);
        overlayContent = content;

        const loadBtn = document.createElement('button');
        loadBtn.className = 'yande-load-btn';
        loadBtn.textContent = '加载下一批';
        content.appendChild(loadBtn);
        overlayLoadBtn = loadBtn;

        // 应用主题样式
        applyThemeStyles();

        document.getElementById('applyBtn').onclick = () => {
            pagePerBatch = +document.getElementById('pageCount').value;
            limitPerPage = +document.getElementById('limitCount').value;
            minScore = +document.getElementById('minScoreInput').value;
            sortType = document.getElementById('orderTypeSelect').value;
            const imageModeEl = document.getElementById('imageModeSelect');
            cardImageMode = normalizeCardImageMode(imageModeEl?.value);
            if (imageModeEl) imageModeEl.value = cardImageMode;
            saveCardImageMode(cardImageMode);
            const columnInput = document.getElementById('columnCount');
            preferredColumns = normalizeGridColumns(columnInput.value, DEFAULT_GRID_COLUMNS);
            columnInput.value = String(preferredColumns);
            saveGridColumns(preferredColumns);

            currentBatch = document.getElementById('startPageCount').value - 1;
            totalLoaded = 0;
            loadedPosts = [];
            loadedPostMap.clear();
            batchLoadingPromise = null;
            content.innerHTML = '';
            content.appendChild(loadBtn);
            applyThemeStyles();
            void loadNextBatch(content, loadBtn);
        };

        loadBtn.onclick = () => void loadNextBatch(content, loadBtn);
    }

    /**
     * 加载下一批帖子
     * @param {Element} content - 内容容器元素
     * @param {Element} loadBtn - 加载按钮元素
     * @returns {Promise} 加载完成的 Promise
     * @description 加载下一批帖子并添加到网格中
     */
    async function loadNextBatch(content, loadBtn) {
        if (batchLoadingPromise) return batchLoadingPromise;

        batchLoadingPromise = (async () => {
            currentBatch++;

            const params = new URLSearchParams(location.search);
            let tags = params.get('tags') || '';
            tags += ` score:>=${minScore}`;
            if (sortType !== '1') {
                tags += ` order:${sortType === '2' ? 'score' : 'favcount'}`;
            }

            const startPage = (currentBatch - 1) * pagePerBatch + 1;

            const title = document.createElement('h2');
            title.className = 'yande-batch-title';
            title.textContent = `第 ${currentBatch} 批`;
            content.insertBefore(title, loadBtn);

            const grid = document.createElement('div');
            grid.className = 'yande-fullscreen-grid';
            grid.style.cssText = `display:grid; gap:16px;`;
            content.insertBefore(grid, loadBtn);
            applyGridColumns(grid);

            for (let i = 0; i < pagePerBatch; i++) {
                const page = startPage + i;
                await loadPage(tags, page, limitPerPage, grid);
            }

            // 批量应用主题样式，减少重绘
            applyThemeStyles();
        })();

        try {
            await batchLoadingPromise;
        } finally {
            batchLoadingPromise = null;
        }
    }

    /**
     * 加载单个页面的帖子
     * @param {string} tags - 标签
     * @param {number} page - 页码
     * @param {number} limit - 每页数量
     * @param {Element} grid - 网格元素
     * @returns {Promise} 加载完成的 Promise
     * @description 从 API 加载单个页面的帖子并渲染到网格中
     */
    async function loadPage(tags, page, limit, grid) {
        const url = `https://yande.re/post.json?tags=${encodeURIComponent(tags)}&page=${page}&limit=${limit}`;
        const res = await fetch(url, { credentials: 'include' });
        const posts = await res.json();
        const shouldAutoPersist = shouldAutoPersistFavoriteIds(tags);
        if (shouldAutoPersist && Array.isArray(posts) && posts.length) {
            persistFavoriteStateBulk(posts.map(post => post?.id), true, 'favorite-query-bulk-import');
        }

        posts.forEach(post => {
            loadedPosts.push(post);
            loadedPostMap.set(post.id, post);
            renderPost(post, grid, loadedPosts.length - 1);
            totalLoaded++;
        });

        document.getElementById('totalInfo').textContent = `已加载：${totalLoaded}`;
    }

    /**
     * 渲染帖子卡片
     * @param {Object} post - 帖子对象
     * @param {Element} grid - 网格元素
     * @param {number} index - 帖子索引
     * @description 渲染单个帖子卡片并添加到网格中
     */
    function renderPost(post, grid, index) {
        const card = document.createElement('div');
        card.className = 'yande-card';
        card.dataset.postId = String(post.id);
        card.style.cssText = `
            position:relative;
            box-sizing:border-box;
            border-radius:16px;
            overflow:hidden;
            transition:transform .2s ease, box-shadow .2s ease;
        `;

        const img = document.createElement('img');
        img.dataset.postId = String(post.id);
        img.src = getCardImageUrl(post);
        img.style.cssText = 'width:100%; cursor:pointer; display:block;';
        img.onclick = () => openViewer(index);

        const score = document.createElement('div');
        score.className = 'yande-score';
        score.textContent = `${post.score}`;
        score.style.cssText = `
            position:absolute;
            top:10px;
            right:10px;
            padding:4px 9px;
            border-radius:999px;
            font-size:12px;
            font-weight:700;
        `;

        const favBtn = createFavButton(post);
        favBtn.style.left = '10px';
        favBtn.style.bottom = '10px';

        const linkBtn = document.createElement('a');
        linkBtn.className = 'yande-link-btn';
        linkBtn.href = `/post/show/${post.id}`;
        linkBtn.target = '_blank';
        linkBtn.textContent = '打开';
        linkBtn.style.cssText = `
            position:absolute;
            bottom:10px;
            right:10px;
            padding:4px 10px;
            color:white;
            text-decoration:none;
            border-radius:999px;
            font-weight:700;
        `;

        card.appendChild(img);
        card.appendChild(score);
        card.appendChild(favBtn);
        card.appendChild(linkBtn);

        applyCardFavoriteStyle(card, favState.has(post.id));
        grid.appendChild(card);
    }

    /**
     * 创建收藏按钮
     * @param {Object} post - 帖子对象
     * @returns {Element} 收藏按钮元素
     * @description 创建带有收藏功能的按钮
     */
    function createFavButton(post) {
        const btn = document.createElement('div');
        btn.className = 'yande-fav-btn';
        btn.dataset.postId = String(post.id);
        btn.style.cssText = `
            position:absolute;
            padding:6px 10px;
            border-radius:999px;
            font-size:12px;
            font-weight:700;
            cursor:pointer;
        `;

        updateFavUI(btn, favState.has(post.id));

        btn.onclick = async e => {
            e.stopPropagation();

            const isFav = favState.has(post.id);
            const newState = !isFav;

            try {
                const response = await fetch('https://yande.re/post/vote.json', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': getCSRFToken()
                    },
                    body: `id=${post.id}&score=${newState ? 3 : 0}`
                });

                if (response.ok) {
                    persistFavoriteState(post.id, newState, 'overlay-toggle');
                }
            } catch (error) {
                console.error('收藏操作失败:', error);
            }
        };

        return btn;
    }

    /**
     * 更新收藏按钮 UI
     * @param {Element} btn - 收藏按钮元素
     * @param {boolean} state - 收藏状态
     * @description 根据收藏状态更新按钮文本
     */
    function updateFavUI(btn, state) {
        btn.textContent = state ? '已收藏' : '收藏';
    }

    /**
     * 格式化文件大小为 MB
     * @param {number} size - 文件大小（字节）
     * @returns {string|null} 格式化后的大小字符串，或 null 如果输入无效
     * @description 将字节大小转换为 MB 格式
     */
    function formatMB(size) {
        if (!Number.isFinite(size) || size <= 0) return null;
        return `${(size / (1024 * 1024)).toFixed(2)} MB`;
    }

    /**
     * 获取查看器中的大小信息文本
     * @param {Object} post - 帖子对象
     * @returns {string} 大小信息文本
     * @description 生成包含不同格式图片大小的信息文本
     */
    function getViewerSizeText(post) {
        const entries = [];
        const pushEntry = (label, size, url) => {
            const formatted = formatMB(size);
            if (!formatted || !url) return;
            if (entries.some(item => item.url === url)) return;
            entries.push({ label, text: formatted, url });
        };

        pushEntry('原图', post.file_size, post.file_url);
        pushEntry('JPEG', post.jpeg_file_size, post.jpeg_url);
        pushEntry('PNG', post.png_file_size, post.png_url);

        if (!entries.length) return '大小信息不可用';
        return entries.map(item => `${item.label} ${item.text}`).join(' · ');
    }

    /**
     * 更新查看器内容
     * @param {number} index - 帖子索引
     * @description 更新图片查看器的内容，包括图片、收藏按钮和大小信息
     */
    function updateViewerContent(index) {
        const post = loadedPosts[index];
        if (!post || !viewer || !viewerImg) return;

        currentIndex = index;
        viewerStatus.textContent = '加载中...';
        viewerStatus.style.display = 'block';
        viewerImg.style.opacity = '0';

        viewerImg.onload = () => {
            viewerImg.style.opacity = '1';
            viewerStatus.style.display = 'none';
        };
        viewerImg.onerror = () => {
            viewerStatus.textContent = '图片加载失败，点击重试';
            viewerStatus.style.display = 'block';
        };

        viewerStatus.onclick = e => {
            e.stopPropagation();
            if (viewerStatus.textContent.includes('失败')) {
                const retrySrc = `${post.sample_url}${post.sample_url.includes('?') ? '&' : '?'}retry=${Date.now()}`;
                viewerImg.src = retrySrc;
            }
        };

        viewerImg.src = post.sample_url;

        const newFavBtn = createFavButton(post);
        newFavBtn.style.left = '20px';
        newFavBtn.style.bottom = '20px';
        viewerFavBtn.replaceWith(newFavBtn);
        viewerFavBtn = newFavBtn;

        viewerLinkBtn.href = `/post/show/${post.id}`;
        viewerSizeInfo.textContent = getViewerSizeText(post);
    }

    /**
     * 确保下一批帖子已加载
     * @returns {Promise<boolean>} 是否成功加载了新帖子
     * @description 当查看器到达当前加载的最后一张图片时，尝试加载下一批帖子
     */
    async function ensureNextPostLoaded() {
        if (!overlayContent || !overlayLoadBtn || batchLoadingPromise) return false;
        const oldLength = loadedPosts.length;
        await loadNextBatch(overlayContent, overlayLoadBtn);
        return loadedPosts.length > oldLength;
    }

    /**
     * 打开图片查看器
     * @param {number} index - 帖子索引
     * @description 打开图片查看器并显示指定索引的帖子图片
     */
    function openViewer(index) {
        if (index < 0 || index >= loadedPosts.length) return;

        if (viewer) {
            updateViewerContent(index);
            return;
        }

        viewer = document.createElement('div');
        viewer.className = 'yande-viewer';
        viewer.style.cssText = `
            position:fixed;
            inset:0;
            backdrop-filter:blur(3px);
            display:flex;
            justify-content:center;
            align-items:center;
            z-index:9999999;
        `;
        viewer.addEventListener('wheel', async e => {
            e.preventDefault();
            e.stopPropagation();
            const now = Date.now();
            if (now - lastWheelAt < 120) return;
            lastWheelAt = now;
            await switchImage(e.deltaY > 0 ? 1 : -1);
        }, { passive: false });

        const img = document.createElement('img');
        img.style.cssText = 'max-width:92%; max-height:92%; border-radius:12px; box-shadow:0 20px 40px rgba(0,0,0,.35); transition:opacity .18s ease; opacity:0;';
        img.onclick = e => e.stopPropagation(); // 防止点击图片关闭查看器
        viewerImg = img;

        const status = document.createElement('div');
        status.style.cssText = `
            position:absolute;
            top:20px;
            left:50%;
            transform:translateX(-50%);
            padding:6px 12px;
            border-radius:999px;
            background:rgba(0,0,0,.55);
            color:#fff;
            font-size:12px;
            user-select:none;
        `;
        viewerStatus = status;

        const favBtn = createFavButton(loadedPosts[index]);
        favBtn.style.left = '20px';
        favBtn.style.bottom = '20px';
        viewerFavBtn = favBtn;

        const linkBtn = document.createElement('a');
        linkBtn.className = 'yande-link-btn';
        linkBtn.target = '_blank';
        linkBtn.textContent = '打开';
        linkBtn.style.cssText = `
            position:absolute;
            bottom:20px;
            right:20px;
            padding:6px 12px;
            color:white;
            text-decoration:none;
            border-radius:999px;
            font-weight:700;
            font-size:12px;
        `;
        linkBtn.onclick = e => e.stopPropagation();
        viewerLinkBtn = linkBtn;

        const sizeInfo = document.createElement('div');
        sizeInfo.style.cssText = `
            position:absolute;
            right:20px;
            top:20px;
            max-width:48vw;
            padding:6px 10px;
            border-radius:10px;
            background:rgba(0,0,0,.42);
            color:#fff;
            font-size:12px;
            line-height:1.35;
            text-align:right;
            pointer-events:none;
        `;
        viewerSizeInfo = sizeInfo;

        viewer.appendChild(img);
        viewer.appendChild(status);
        viewer.appendChild(favBtn);
        viewer.appendChild(linkBtn);
        viewer.appendChild(sizeInfo);
        viewer.onclick = closeViewer;

        document.body.appendChild(viewer);
        updateViewerContent(index);
        applyThemeStyles();
    }

    /**
     * 关闭图片查看器
     * @description 关闭并清理图片查看器
     */
    function closeViewer() {
        if (!viewer) return;
        viewer.remove();
        viewer = null;
        viewerImg = null;
        viewerStatus = null;
        viewerFavBtn = null;
        viewerLinkBtn = null;
        viewerSizeInfo = null;
    }

    /**
     * 切换图片
     * @param {number} direction - 切换方向，1 表示下一张，-1 表示上一张
     * @returns {Promise} 切换完成的 Promise
     * @description 切换到下一张或上一张图片，到达边界时尝试加载更多
     */
    async function switchImage(direction) {
        let nextIndex = currentIndex + direction;

        if (direction < 0 && nextIndex < 0) {
            nextIndex = 0;
        }

        if (direction > 0 && nextIndex >= loadedPosts.length) {
            const loaded = await ensureNextPostLoaded();
            nextIndex = loaded ? currentIndex + direction : loadedPosts.length - 1;
        }

        if (nextIndex < 0) nextIndex = 0;
        if (nextIndex >= loadedPosts.length) nextIndex = loadedPosts.length - 1;

        if (nextIndex !== currentIndex) {
            openViewer(nextIndex);
        }
    }

    // 初始化收藏状态和监听
    initializeFavoriteStateForPostPage();
    setupFavoriteActionListenerForPostPage();
})();
