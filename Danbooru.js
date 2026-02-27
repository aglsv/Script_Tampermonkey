// ==UserScript==
// @name         Danbooru — Global Sort by Favorites (Search Only)
// @namespace    https://danbooru.donmai.us/
// @version      2.0
// @description  在搜索结果页自动根据收藏数排序（跨页），其他页面不运行
// @author       时雨行
// @match        https://danbooru.donmai.us/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  const MAX_PAGES = 10;      // 拉取的最大页数（每页100个帖子）
  const PAGE_SIZE = 100;
  const BUTTON_ID = 'gm-danbooru-global-sort';
  const PROGRESS_ID = 'gm-danbooru-progress';

  /** 简易 DOM 工具 **/
  function $(sel, root = document) { return root.querySelector(sel); }
  function createEl(tag, attrs = {}) {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    return el;
  }

  /** UI：创建按钮 + 进度条 **/
  function createUI() {
    if (document.getElementById(BUTTON_ID)) return;
    const btn = createEl('button', {
      id: BUTTON_ID,
      textContent: 'Sort by Favorites',
    });
    Object.assign(btn.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: 9999,
      padding: '8px 12px',
      background: '#0b7dda',
      color: 'white',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      fontSize: '13px',
    });
    document.body.appendChild(btn);

    const prog = createEl('div', { id: PROGRESS_ID });
    Object.assign(prog.style, {
      position: 'fixed',
      right: '12px',
      bottom: '52px',
      zIndex: 9999,
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      borderRadius: '6px',
      fontSize: '12px',
      display: 'none',
    });
    document.body.appendChild(prog);

    return { btn, prog };
  }

  function showProgress(msg) {
    const prog = document.getElementById(PROGRESS_ID);
    if (!prog) return;
    prog.style.display = 'block';
    prog.textContent = msg;
  }

  function hideProgress() {
    const prog = document.getElementById(PROGRESS_ID);
    if (prog) prog.style.display = 'none';
  }

  /** 拉取一页 JSON 数据 **/
  async function fetchPage(tags, page) {
    const url = `/posts.json?tags=${encodeURIComponent(tags)}&limit=${PAGE_SIZE}&page=${page}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  /** 拉取所有搜索结果 **/
  async function fetchAllPosts(tags) {
    let all = [];
    for (let p = 1; p <= MAX_PAGES; p++) {
      showProgress(`Fetching page ${p}/${MAX_PAGES}... (${all.length} posts so far)`);
      const list = await fetchPage(tags, p);
      if (!Array.isArray(list) || list.length === 0) break;
      all = all.concat(list);
      if (list.length < PAGE_SIZE) break;
    }
    return all;
  }

  /** 渲染排序后的帖子缩略图 **/
  function renderPosts(posts) {
    const container = $('#posts') || $('#post-list') || $('section#posts');
    if (!container) {
      alert('无法找到帖子容器 (#posts)');
      return;
    }
    container.innerHTML = '';

    const frag = document.createDocumentFragment();
    for (const p of posts) {
      const link = createEl('a', {
        href: `/posts/${p.id}`,
        target: '_blank',
        title: `${p.tag_string_artist || ''} ❤️${p.fav_count}`,
      });
      Object.assign(link.style, {
        display: 'inline-block',
        margin: '4px',
      });


      const img = createEl('img', {
        // 使用type为720的缩略图（如果有）
        src: p.media_asset.variants[2].src || p.preview_file_url || p.large_file_url || p.file_url,
        alt: p.tag_string_character || '',
        loading: 'lazy',
      });
      Object.assign(img.style, {
        maxWidth: '150px',
        maxHeight: '150px',
        objectFit: 'cover',
        borderRadius: '4px',
      });

      link.appendChild(img);
      frag.appendChild(link);
    }
    container.appendChild(frag);
  }

  /** 主逻辑：排序整个搜索结果 **/
  async function sortAllByFavorites() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const tags = urlParams.get('tags');
      if (!tags) {
        alert('此页面不是搜索结果页（无 tags 参数），不进行排序。');
        return;
      }

      showProgress('Fetching posts...');
      const posts = await fetchAllPosts(tags);
      if (posts.length === 0) {
        alert('未获取到搜索结果或已超出最大页数限制。');
        hideProgress();
        return;
      }

      showProgress(`Sorting ${posts.length} posts by fav_count...`);
      posts.sort((a, b) => (b.fav_count || 0) - (a.fav_count || 0));

      showProgress('Rendering sorted results...');
      renderPosts(posts);
      showProgress(`Done — ${posts.length} posts sorted.`);
      setTimeout(hideProgress, 2500);
    } catch (err) {
      console.error(err);
      alert('排序时出现错误：' + err.message);
      hideProgress();
    }
  }

  /** 初始化 **/
  const { btn } = createUI();
  const url = window.location.href;

  // 仅在搜索页启用（含有 ?tags=）
  const isSearchPage = url.includes('tags=');

  if (isSearchPage) {
    btn.textContent = 'Sort All by Favorites';
    btn.addEventListener('click', sortAllByFavorites);
    // 可选：自动运行
    // sortAllByFavorites();
  } else {
    btn.style.opacity = '0.5';
    btn.textContent = 'Sort disabled (not search page)';
    btn.title = '仅在搜索结果页启用';
    btn.disabled = true;
  }
})();
