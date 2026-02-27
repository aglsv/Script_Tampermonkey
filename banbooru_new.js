// ==UserScript==
// @name         Danbooru 排序增强//
// @namespace    https://danbooru.donmai.us/
// @version      1.1.0
// @description  搜索页按收藏数排序，显示大型缩略图，支持悬停喜欢按钮，点击加载下一批结果并自动分割显示
// @author       时雨行
// @match        https://danbooru.donmai.us/posts*
// @grant        none
// @connect      danbooru.donmai.us
// ==/UserScript==

(function () {
  'use strict'

  const isSearchPage = location.search.includes('tags=')
  if (!isSearchPage) return // 非搜索页不处理

  const BUTTON_ID = 'gm-danbooru-global-sort';
  const PROGRESS_ID = 'gm-danbooru-progress';


  let wrapper
  let loadMoreBtn

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

  const { btn } = createUI();
  btn.textContent = '按照喜欢排序';
  btn.addEventListener('click', ()=>{
    init()
  });

  function init () {
    const container = document.querySelector('#posts') || document.querySelector('.posts-container')
    if (!container) return

    // 初始化区域
    wrapper = document.createElement('div')
    wrapper.style.display = 'flex'
    wrapper.style.flexDirection = 'column'
    wrapper.style.gap = '20px'
    container.innerHTML = ''
    container.appendChild(wrapper)

    loadMoreBtn = document.createElement('button')
    loadMoreBtn.textContent = '加载下一批结果'
    loadMoreBtn.style.margin = '30px auto'
    loadMoreBtn.style.padding = '10px 20px'
    loadMoreBtn.style.fontSize = '16px'
    loadMoreBtn.style.cursor = 'pointer'
    loadMoreBtn.style.border = '1px solid #aaa'
    loadMoreBtn.style.borderRadius = '8px'
    loadMoreBtn.style.background = 'linear-gradient(to bottom, #fff, #eee)'
    loadMoreBtn.style.transition = 'all 0.2s'
    loadMoreBtn.addEventListener('mouseenter', () => loadMoreBtn.style.background = '#ddd')
    loadMoreBtn.addEventListener('mouseleave', () => loadMoreBtn.style.background = 'linear-gradient(to bottom, #fff, #eee)')
    container.appendChild(loadMoreBtn)

    loadMoreBtn.addEventListener('click', () => {
      loadBatch(currentBatch + 1)
    })

    loadBatch(1)
  }


  const tagParam = new URLSearchParams(location.search).get('tags') || ''

  // config 属性
  // 每页数量
  let pageLimit = 200
  // 总页数
  let perBatchPages = 2
  // 当前页数
  let currentPage = 0
  let currentBatch = 0
  let loading = false

  const settingDiv = document.createElement('div')
  // 设置样式
  Object.assign(settingDiv.style, {
    display: 'flex',
    position: 'sticky',
    top: '0',
    zIndex: '1000',
    backgroundColor: '#1E1E2C',
    padding: '10px',
    borderBottom: '1px solid rgb(204, 204, 204)',
    alignItems: 'center',
    color: '#4bb4ff'
  })

// 添加内容
  settingDiv.innerHTML = `设置：<button style="margin: 10px; cursor: pointer;">重新加载</button>每页数量：<input class="pageLimit" type="number" style="margin: 10px; width: 50px; text-align: center;">加载页数：<input class="pageNum" type="number" style="margin: 10px; width: 50px; text-align: center;">`
  const contentContainer = document.querySelector('#content')
  if (contentContainer) {
    contentContainer.insertBefore(settingDiv, contentContainer.firstChild)
  } else {
    // 如果找不到 content 容器，则添加到 body 顶部
    document.body.insertBefore(settingDiv, document.body.firstChild)
  }

  // 找到设置数量的输入框
  const pageLimitInput = settingDiv.querySelector('input.pageLimit')
  pageLimitInput.value = pageLimit
  pageLimitInput.addEventListener('change', () => {
    pageLimit = Number(pageLimitInput.value)
  })

  // 找到设置页数输入框
  const pageNumInput = settingDiv.querySelector('input.pageNum')
  pageNumInput.value = perBatchPages
  pageNumInput.addEventListener('change', () => {
    perBatchPages = Number(pageNumInput.value)
  })

  // 找到重新加载按钮
  const reloadBtn = settingDiv.querySelector('button')
  reloadBtn.addEventListener('click', () => {
    wrapper.innerHTML = ''
    currentPage = 0
    currentBatch = 0
    loadBatch(1)
  })

  async function fetchPosts (page) {
    const url = `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(tagParam)}&page=${page}&limit=${pageLimit}`
    const res = await fetchPostsWithLogin(url)
    return res.json()
  }

  async function loadBatch (batchIndex) {
    if (loading) return
    const startPage = currentPage + 1
    const endPage = startPage + perBatchPages - 1
    console.log(`加载第 ${startPage} - ${endPage} 页...`)

    let loadPageNum = startPage
    loading = true
    loadMoreBtn.textContent = `第 ${loadPageNum} 页加载中...`

    currentPage = endPage
    const posts = []

    for (let page = startPage; page <= endPage; page++) {
      loadPageNum = page
      console.log(`加载第 ${page} 页...`)
      const data = await fetchPosts(page)
      if (!data.length) break
      posts.push(...data)
    }

    posts.sort((a, b) => b.fav_count - a.fav_count)

    // 每批单独显示
    const section = document.createElement('div')
    section.style.borderTop = '2px solid #ccc'
    section.style.paddingTop = '10px'
    section.innerHTML = `<h3 style="margin:10px 0;">第 ${batchIndex} 批（第 ${startPage} - ${endPage} 页）</h3>`

    const grid = document.createElement('div')
    grid.style.display = 'flex'
    grid.style.flexWrap = 'wrap'
    grid.style.gap = '8px'

    posts.forEach(p => {
      const link = document.createElement('a')
      link.href = `/posts/${p.id}`
      link.target = '_blank'
      link.style.position = 'relative'
      link.style.display = 'inline-block'
      link.title = `${p.tag_string_artist || ''} ❤️${p.fav_count} size: ${p.image_width}x${p.image_height}}`

      const img = document.createElement('img')
      // 使用type为720的缩略图（如果有）
      img.src = (p.media_asset.variants && p.media_asset.variants[2] && p.media_asset.variants[2].url) || p.preview_file_url || p.large_file_url || p.file_url
      img.loading = 'lazy'
      img.style.maxWidth = '1000px'
      img.style.maxHeight = '720px'
      img.style.borderRadius = '8px'
      img.style.transition = 'transform 0.2s'
      img.addEventListener('mouseenter', () => (img.style.transform = 'scale(1.05)'))
      img.addEventListener('mouseleave', () => (img.style.transform = 'scale(1)'))
      link.appendChild(img)

      // ❤️ 悬停喜欢按钮
      const favBtn = document.createElement('button')
      favBtn.name = 'button'
      favBtn.type = 'submit'
      favBtn.className = 'text-lg py-1 px-3'
      favBtn.setAttribute('data-disable-with', '<svg class="icon svg-icon spinner-icon animate-spin" viewBox="0 0 512 512"><use fill="currentColor" href="/packs/static/icons-9fcf22a5166a2c24e889.svg#spinner" /></svg>')
      favBtn.innerHTML = '<svg class="icon svg-icon empty-heart-icon" viewBox="0 0 512 512"><use fill="currentColor" href="/packs/static/icons-9fcf22a5166a2c24e889.svg#solid-heart"></use></svg>'

      favBtn.style.position = 'absolute'
      favBtn.style.top = '8px'
      favBtn.style.right = '8px'
      favBtn.style.display = 'none'
      favBtn.style.background = 'rgba(255,255,255,0.8)'
      favBtn.style.border = '1px solid black'
      favBtn.style.cursor = 'pointer'
      favBtn.style.height = '30px'
      favBtn.style.textAlign = 'center'
      favBtn.title = '加入喜欢'

      const svg = favBtn.querySelector('svg')
      svg.style.color = 'black'
      favBtn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        addFavorite(p.id, favBtn)
      }
      link.appendChild(favBtn)

      link.addEventListener('mouseenter', () => {favBtn.style.display = 'block'})
      link.addEventListener('mouseleave', () => {favBtn.style.display = 'none'})

      grid.appendChild(link)
    })

    section.appendChild(grid)
    wrapper.appendChild(section)

    currentBatch++
    loading = false
    loadMoreBtn.textContent = '加载下一批结果'
  }

  async function addFavorite (postId, btn) {
    try {
      btn.disabled = true

      // 读取 CSRF token（若页面存在）
      const meta = document.querySelector('meta[name="csrf-token"]')
      const csrf = meta ? meta.getAttribute('content') : null

      const resp = await fetch('/favorites', {
        method: 'POST',
        credentials: 'same-origin', // <-- 关键：使用同源 cookie（登录态）
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: `post_id=${encodeURIComponent(postId)}`
      })

      if (resp.status === 201) {
        btn.querySelector('.svg-icon').style.color = '#ff5a5b'
      } else if (resp.status === 200 || resp.status === 204) {
        // 有些站点在不同配置下返回200/204
        btn.querySelector('.svg-icon').style.color = '#ff5a5b'
      } else {
        const txt = await resp.text()
        console.warn('favorite failed', resp.status, txt)
        btn.disabled = false
      }
    } catch (err) {
      console.error(err)
      btn.disabled = false
    }
  }

  async function fetchPostsWithLogin(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // ✅ 必须带上 cookie
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }

    return response;
  }

  // // 初始加载一批
  // loadBatch(1)


})()
