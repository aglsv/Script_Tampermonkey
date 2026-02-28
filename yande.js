// ==UserScript==
// @name         Yande 全屏浏览器7.1（排序+收藏）
// @namespace    https://yande.re/
// @version      7.1
// @match        https://yande.re/post*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

function getCSRFToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content;
}

(function () {
    'use strict';
    if (!location.pathname.startsWith('/post')) return;

    let overlay = null;
    let viewer = null;

    let currentBatch = 0;
    let pagePerBatch = 3;
    let limitPerPage = 20;
    let totalLoaded = 0;
    let minScore = 0;
    const GRID_COLS_STORAGE_KEY = 'yande.gridColumns';
    const THEME_STORAGE_KEY = 'yande.themeMode';
    const DEFAULT_GRID_COLUMNS = 4;
    const MIN_GRID_COLUMNS = 1;
    const MAX_GRID_COLUMNS = 12;
    const MIN_CARD_WIDTH = 340;
    const MIN_COLUMNS_ON_NARROW = 2;
    let preferredColumns = readStoredGridColumns();
    let themeMode = readStoredThemeMode();

    let loadedPosts = [];
    let currentIndex = 0;
    let overlayContent = null;
    let overlayLoadBtn = null;
    let batchLoadingPromise = null;
    let viewerImg = null;
    let viewerStatus = null;
    let viewerFavBtn = null;
    let viewerLinkBtn = null;
    let viewerSizeInfo = null;
    let lastWheelAt = 0;

    let sortType = '1'; // 排序类型，1=默认，2=评分，3=收藏数

    // 排序选项
    const data = [
        { value: '1', text: '默认' },
        { value: '2', text: '评分' },
        { value: '3', text: '收藏数' }
    ];

    // 记录当前会话内的本地收藏状态
    const FAV_STATE_STORAGE_KEY = 'yande.favoriteStateMap';
    const favState = new Set();
    const persistedFavState = readStoredFavoriteStateMap();
    hydrateFavStateFromStorage();
    const onOverlayResize = () => refreshAllGridColumns();

    function normalizeGridColumns(value, fallback = DEFAULT_GRID_COLUMNS) {
        const parsed = Math.floor(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(MAX_GRID_COLUMNS, Math.max(MIN_GRID_COLUMNS, parsed));
    }

    function readStoredGridColumns() {
        try {
            const raw = GM_getValue(GRID_COLS_STORAGE_KEY, DEFAULT_GRID_COLUMNS);
            return normalizeGridColumns(raw, DEFAULT_GRID_COLUMNS);
        } catch (e) {
            return DEFAULT_GRID_COLUMNS;
        }
    }

    function saveGridColumns(columns) {
        try {
            GM_setValue(GRID_COLS_STORAGE_KEY, normalizeGridColumns(columns, DEFAULT_GRID_COLUMNS));
        } catch (e) {
            // 忽略存储错误
        }
    }

    function normalizeThemeMode(value) {
        return value === 'dark' ? 'dark' : 'light';
    }

    function readStoredThemeMode() {
        try {
            return normalizeThemeMode(GM_getValue(THEME_STORAGE_KEY, 'light'));
        } catch (e) {
            return 'light';
        }
    }

    function saveThemeMode(mode) {
        try {
            GM_setValue(THEME_STORAGE_KEY, normalizeThemeMode(mode));
        } catch (e) {
            // 忽略存储错误
        }
    }

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

    function persistFavoriteState(postId, state, source = 'unknown') {
        const normalizedId = Number(postId);
        if (!Number.isFinite(normalizedId)) return;

        if (state) {
            favState.add(normalizedId);
        } else {
            favState.delete(normalizedId);
        }

        persistedFavState[String(normalizedId)] = !!state;

        try {
            GM_setValue(FAV_STATE_STORAGE_KEY, persistedFavState);
            console.log(`[YandeFavSync] 帖子 ${normalizedId} 收藏状态已更新为 ${state ? '已收藏' : '未收藏'}（来源：${source}）`);
        } catch (e) {
            console.error(`[YandeFavSync] 保存帖子 ${normalizedId} 收藏状态失败:`, e);
        }
    }

    function isPostShowPage(pathname = location.pathname) {
        return /^\/post\/show\/\d+/.test(pathname);
    }

    function getCurrentPostIdFromPath(pathname = location.pathname) {
        const match = pathname.match(/^\/post\/show\/(\d+)/);
        if (!match) return null;
        const postId = Number(match[1]);
        return Number.isFinite(postId) ? postId : null;
    }

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

        if (/remove|unfav|取消收藏|取消\s*收藏|delete\s*fav/.test(textSegments)) return false;
        if (/add|favorite|favourite|收藏/.test(textSegments)) return true;

        return null;
    }

    function findFavoriteControlInPage() {
        const selectors = [
            '#add-to-favs a',
            '#add-to-favs input[type="submit"]',
            '#add-to-favs button',
            'a[href*="/post/vote"]',
            'form[action*="/post/vote"] input[type="submit"]',
            'form[action*="/post/vote"] button'
        ];

        for (const selector of selectors) {
            const candidates = document.querySelectorAll(selector);
            for (const node of candidates) {
                if (getFavoriteActionFromElement(node) !== null) return node;
            }
        }

        return null;
    }

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

                const favoriteState = getFavoriteActionFromElement(control);
                if (favoriteState === null) {
                    console.warn(`[YandeFavSync] 无法识别帖子 ${postId} 收藏按钮状态。`);
                    return;
                }

                persistFavoriteState(postId, favoriteState, 'page-load');
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

    function findFavoriteControlFromTarget(target) {
        if (!(target instanceof Element)) return null;

        const selectors = [
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
                    const latestState = getFavoriteActionFromElement(latestControl);
                    if (latestState !== null) {
                        persistFavoriteState(postId, latestState, 'post-click-refresh');
                    }
                }, 300);
            } catch (err) {
                console.error(`[YandeFavSync] 监听收藏点击失败，帖子 ${postId}:`, err);
            }
        }, true);
    }

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
            mediaBg: '#f3f4f6',
            badgeBg: 'rgba(17,24,39,0.76)',
            viewerBg: 'rgba(15,23,42,0.92)'
        };
    }

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
            card.style.background = t.cardBg;
            card.style.boxShadow = t.cardShadow;
            card.onmouseenter = () => {
                card.style.transform = 'translateY(-3px)';
                card.style.boxShadow = t.cardHoverShadow;
            };
            card.onmouseleave = () => {
                card.style.transform = 'translateY(0)';
                card.style.boxShadow = t.cardShadow;
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

    function getEffectiveColumns(containerWidth) {
        const width = Math.max(0, Math.floor(containerWidth || 0));
        const allowedByWidth = Math.floor(width / MIN_CARD_WIDTH);
        let effective = Math.min(preferredColumns, allowedByWidth);
        // 窄屏下至少显示 2 列，但用户选择 1 列时不强制提升
        const narrowFloor = Math.min(MIN_COLUMNS_ON_NARROW, preferredColumns);
        effective = Math.max(narrowFloor, effective);
        return Math.max(1, effective);
    }

    function applyGridColumns(grid) {
        if (!grid) return;
        const effectiveColumns = getEffectiveColumns(grid.clientWidth || grid.offsetWidth);
        grid.style.gridTemplateColumns = `repeat(${effectiveColumns}, minmax(0, 1fr))`;
    }

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

    function closeOverlay() {
        if (!overlay) return;
        window.removeEventListener('resize', onOverlayResize);
        overlay.remove();
        overlay = null;
    }

    // 键盘快捷键
    document.addEventListener('keydown', e => {
        if (viewer) {
            if (e.key === 'ArrowRight') void switchImage(1);
            if (e.key === 'ArrowLeft') void switchImage(-1);
            if (e.key === 'Escape') closeViewer();
        }
    });

    function buildUI() {
        currentBatch = 0;
        totalLoaded = 0;
        loadedPosts = [];

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
            最低评分 <input id="minScoreInput" type="number" value="0" style="width:60px">
            排序 <select id="orderTypeSelect" value="0">${optionsHtml}</select>
            <button id="applyBtn">应用</button>
            <button id="closeBtn">关闭</button>
            <span id="totalInfo">已加载：0</span>
        `;

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
            const columnInput = document.getElementById('columnCount');
            preferredColumns = normalizeGridColumns(columnInput.value, DEFAULT_GRID_COLUMNS);
            columnInput.value = String(preferredColumns);
            saveGridColumns(preferredColumns);

            currentBatch = document.getElementById('startPageCount').value - 1;
            totalLoaded = 0;
            loadedPosts = [];
            batchLoadingPromise = null;
            content.innerHTML = '';
            content.appendChild(loadBtn);
            applyThemeStyles();
            void loadNextBatch(content, loadBtn);
        };

        loadBtn.onclick = () => void loadNextBatch(content, loadBtn);
    }

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

    async function loadPage(tags, page, limit, grid) {
        const url = `https://yande.re/post.json?tags=${encodeURIComponent(tags)}&page=${page}&limit=${limit}`;
        const res = await fetch(url, { credentials: 'include' });
        const posts = await res.json();

        posts.forEach(post => {
            loadedPosts.push(post);
            renderPost(post, grid, loadedPosts.length - 1);
            totalLoaded++;
        });

        document.getElementById('totalInfo').textContent = `已加载：${totalLoaded}`;
    }

    function renderPost(post, grid, index) {
        const card = document.createElement('div');
        card.className = 'yande-card';
        card.style.cssText = `
            position:relative;
            border-radius:16px;
            overflow:hidden;
            transition:transform .2s ease, box-shadow .2s ease;
        `;

        const img = document.createElement('img');
        img.src = post.sample_url;
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

        grid.appendChild(card);
    }

    function createFavButton(post) {
        const btn = document.createElement('div');
        btn.className = 'yande-fav-btn';
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
                    updateFavUI(btn, newState);
                }
            } catch (error) {
                console.error('收藏操作失败:', error);
            }
        };

        return btn;
    }

    function updateFavUI(btn, state) {
        btn.textContent = state ? '已收藏' : '收藏';
    }

    function formatMB(size) {
        if (!Number.isFinite(size) || size <= 0) return null;
        return `${(size / (1024 * 1024)).toFixed(2)} MB`;
    }

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

    async function ensureNextPostLoaded() {
        if (!overlayContent || !overlayLoadBtn || batchLoadingPromise) return false;
        const oldLength = loadedPosts.length;
        await loadNextBatch(overlayContent, overlayLoadBtn);
        return loadedPosts.length > oldLength;
    }

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

    initializeFavoriteStateForPostPage();
    setupFavoriteActionListenerForPostPage();
})();
