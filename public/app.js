/**
 * 养小基 - 主应用逻辑
 * 高性能PWA基金管理应用
 */

(function() {
  'use strict';

  // ==========================================
  // 配置与常量
  // ==========================================
  
  const API = '/api/index';
  const CACHE_TTL = 60 * 1000; // 默认缓存 60 秒
  const CACHE_LIMIT = 200;
  const DIRECT_TIMEOUT = 8000;
  const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
  const STORAGE_KEYS = {
    holdings: 'yxj_holdings',
    watchlist: 'yxj_watchlist',
    accounts: 'yxj_accounts',
    searchHistory: 'yxj_search_history',
    cache: 'yxj_cache',
    emptySectors: 'yxj_empty_sectors',
    fundNames: 'yxj_fund_names'
  };
  // 实测无对应基金数据的板块（点击后为空），默认直接剔除
  const DEFAULT_EMPTY_SECTORS = ['BK1035']; // 美容护理

  // ==========================================
  // 状态管理
  // ==========================================
  
  const state = {
    currentPage: 'hold',
    currentAccount: 'summary', // summary, all, 或账户ID
    accounts: [],
    holdings: {},
    watchlist: [],
    cache: {},
    searchHistory: [],
    emptySectors: [],
    fundNameMap: {},
    detailTab: 'stocks',
    sectorOverview: null,
    // 排序状态
    holdSort: { field: 'profit', asc: false },
    watchSort: { field: 'change', asc: false },
    sectorSort: { field: 'change', asc: false }
  };

  // ==========================================
  // 工具函数
  // ==========================================
  
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  
  const fmt = (n, decimals = 2) => {
    if (n === undefined || n === null || n === '' || isNaN(n)) return '--';
    const num = parseFloat(n);
    if (isNaN(num)) return '--';
    return num.toLocaleString('zh-CN', { 
      minimumFractionDigits: decimals, 
      maximumFractionDigits: decimals 
    });
  };
  
  const sign = n => {
    const num = parseFloat(n);
    if (isNaN(num)) return '';
    return num >= 0 ? '+' : '';
  };
  
  const cls = v => {
    const n = parseFloat(String(v).replace('%', '').replace('+', ''));
    if (isNaN(n)) return '';
    return n > 0 ? 'rise' : n < 0 ? 'fall' : '';
  };

  const escapeHtml = (value) => {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const formatMultiline = (value) => {
    if (!value) return '';
    return escapeHtml(value).replace(/\r?\n/g, '<br>');
  };

  const debounce = (fn, delay) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  const toast = msg => {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  };

  // ==========================================
  // 存储管理
  // ==========================================
  
  const storage = {
    get(key, defaultVal = null) {
      try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : defaultVal;
      } catch (e) {
        return defaultVal;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch (e) {
        console.warn('Storage set failed:', e);
      }
    }
  };

  const loadState = () => {
    state.accounts = storage.get(STORAGE_KEYS.accounts, [
      { id: 'default', name: '默认' }
    ]);
    state.holdings = storage.get(STORAGE_KEYS.holdings, {});
    state.watchlist = storage.get(STORAGE_KEYS.watchlist, []);
    state.searchHistory = storage.get(STORAGE_KEYS.searchHistory, []);
    state.cache = storage.get(STORAGE_KEYS.cache, {});
    const cachedEmptySectors = storage.get(STORAGE_KEYS.emptySectors, []);
    state.emptySectors = Array.from(new Set([...DEFAULT_EMPTY_SECTORS, ...cachedEmptySectors]));
    if (state.emptySectors.length !== cachedEmptySectors.length) {
      saveEmptySectors();
    }
    state.fundNameMap = storage.get(STORAGE_KEYS.fundNames, {});

    // 从持仓/自选同步基金名称缓存，避免详情页名称缺失
    let nameUpdated = false;
    Object.values(state.holdings).forEach(list => {
      list.forEach(h => {
        if (h.code && h.name && !state.fundNameMap[h.code]) {
          state.fundNameMap[h.code] = h.name;
          nameUpdated = true;
        }
      });
    });
    state.watchlist.forEach(w => {
      if (w.code && w.name && !state.fundNameMap[w.code]) {
        state.fundNameMap[w.code] = w.name;
        nameUpdated = true;
      }
    });
    if (nameUpdated) saveFundNames();
  };

  const saveHoldings = () => storage.set(STORAGE_KEYS.holdings, state.holdings);
  const saveWatchlist = () => storage.set(STORAGE_KEYS.watchlist, state.watchlist);
  const saveAccounts = () => storage.set(STORAGE_KEYS.accounts, state.accounts);
  const saveSearchHistory = () => storage.set(STORAGE_KEYS.searchHistory, state.searchHistory);
  const saveCache = () => storage.set(STORAGE_KEYS.cache, state.cache);
  const saveEmptySectors = () => storage.set(STORAGE_KEYS.emptySectors, state.emptySectors);
  const saveFundNames = () => storage.set(STORAGE_KEYS.fundNames, state.fundNameMap);

  // ==========================================
  // API 请求（带缓存）
  // ==========================================
  
  const getCacheTTL = (url) => {
    const module = url.searchParams.get('module') || '';
    const action = url.searchParams.get('action') || '';
    if (module === 'market' && action === 'indices') return 10 * 1000;
    if (module === 'fund' && action === 'detail') return 2 * 60 * 1000;
    if (module === 'fund' && action === 'batch') return 20 * 1000;
    if (module === 'fund' && action === 'info') return 60 * 1000;
    if (module === 'fund' && action === 'hot') return 10 * 60 * 1000;
    if (module === 'fund' && action === 'search') return 2 * 60 * 1000;
    if (module === 'sector' && action === 'funds') return 15 * 60 * 1000;
    if (module === 'sector' && action === 'streak') return 2 * 60 * 1000;
    if (module === 'sector' && action === 'list') return 2 * 60 * 1000;
    if (module === 'news') return 5 * 60 * 1000;
    return CACHE_TTL;
  };

  const pruneCache = () => {
    const keys = Object.keys(state.cache);
    if (keys.length <= CACHE_LIMIT) return;
    keys.sort((a, b) => (state.cache[a]?.ts || 0) - (state.cache[b]?.ts || 0));
    const removeCount = keys.length - CACHE_LIMIT;
    keys.slice(0, removeCount).forEach(k => delete state.cache[k]);
  };

  const readCache = (key) => {
    const cached = state.cache[key];
    if (!cached) return null;
    if (cached.data && cached.data.success === false) {
      delete state.cache[key];
      return null;
    }
    const ttl = cached.ttl || CACHE_TTL;
    if (Date.now() - cached.ts < ttl) return cached.data;
    delete state.cache[key];
    return null;
  };

  const writeCache = (key, data, ttl) => {
    state.cache[key] = { data, ts: Date.now(), ttl };
    pruneCache();
    saveCache();
  };

  const rememberFundName = (code, name) => {
    const safeCode = (code || '').trim();
    const safeName = (name || '').trim();
    if (!safeCode || !safeName) return;
    if (state.fundNameMap[safeCode] === safeName) return;
    state.fundNameMap[safeCode] = safeName;
    saveFundNames();
  };

  const getFundNameHint = (code, nameHint) => {
    const safeCode = (code || '').trim();
    if (nameHint && nameHint.trim()) return nameHint.trim();
    const fromWatch = state.watchlist.find(w => w.code === safeCode)?.name;
    if (fromWatch) return fromWatch;
    for (const list of Object.values(state.holdings)) {
      const hit = list.find(h => h.code === safeCode);
      if (hit?.name) return hit.name;
    }
    return state.fundNameMap[safeCode] || '';
  };

  const isMoneyFund = (fund) => {
    const tags = [fund?.category, fund?.type, fund?.name].filter(Boolean).join(' ');
    return /货币|现金/.test(tags);
  };

  const isEmptySector = (code) => state.emptySectors.includes(code);

  const markEmptySector = (code, name) => {
    if (!code || isEmptySector(code)) return;
    state.emptySectors.push(code);
    saveEmptySectors();
    if (Array.isArray(state.sectorOverview)) {
      state.sectorOverview = state.sectorOverview.filter(item => item.code !== code);
    }
    toast(`${name || '该'}板块暂无基金数据，已移出列表`);
  };

  // CORS 允许的上游接口优先直连，失败回退代理
  const fetchJson = async (url, options = {}) => {
    const resp = await fetch(url, {
      ...options,
      headers: { 'Accept': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  };

  const fetchText = async (url, options = {}) => {
    const resp = await fetch(url, {
      ...options,
      headers: { 'Accept': '*/*', ...(options.headers || {}) },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  };

  const runPool = async (items, limit, worker) => {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, () => (async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    })());
    await Promise.allSettled(runners);
  };


  const directSectorList = async () => {
    const url = new URL('https://push2.eastmoney.com/api/qt/clist/get');
    url.searchParams.set('fid', 'f62');
    url.searchParams.set('po', '1');
    url.searchParams.set('pz', '100');
    url.searchParams.set('pn', '1');
    url.searchParams.set('np', '1');
    url.searchParams.set('fltt', '2');
    url.searchParams.set('invt', '2');
    url.searchParams.set('ut', EASTMONEY_UT);
    url.searchParams.set('fs', 'm:90+t:2');
    url.searchParams.set('fields', 'f12,f14,f2,f3,f62,f184,f104,f105');

    const data = await fetchJson(url);
    const diff = data?.data?.diff || [];
    if (!diff.length) throw new Error('empty');

    const sectors = diff.map(item => {
      const rawChange = item.f3;
      const changeVal = rawChange === '-' || rawChange === null ? 0 : Number(rawChange);
      return {
        name: item.f14 || '',
        code: item.f12 || '',
        change_percent: `${changeVal >= 0 ? '+' : ''}${changeVal}%`,
        up_count: item.f104 || 0,
        down_count: item.f105 || 0
      };
    });

    return { success: true, data: sectors };
  };

  const calcSectorStreak = async (code) => {
    // 单板块连涨结果缓存，避免重复多次拉K线
    const cacheKey = `sector_streak_item:${code}`;
    const cached = readCache(cacheKey);
    if (cached !== null) return cached;

    const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
    url.searchParams.set('secid', `90.${code}`);
    url.searchParams.set('klt', '101');
    url.searchParams.set('fqt', '1');
    url.searchParams.set('lmt', '10');
    url.searchParams.set('end', '20500101');
    url.searchParams.set('fields1', 'f1,f2,f3');
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
    url.searchParams.set('ut', EASTMONEY_UT);

    const data = await fetchJson(url);
    const klines = data?.data?.klines || [];
    if (klines.length < 2) {
      writeCache(cacheKey, 0, 30 * 60 * 1000);
      return 0;
    }

    const closes = [];
    klines.forEach(item => {
      const parts = item.split(',');
      if (parts.length >= 3) {
        const close = Number(parts[2]);
        if (!Number.isNaN(close)) closes.push(close);
      }
    });
    if (closes.length < 2) {
      writeCache(cacheKey, 0, 30 * 60 * 1000);
      return 0;
    }

    let streak = 0;
    let lastSign = 0;
    for (let i = closes.length - 1; i > 0; i--) {
      const diff = closes[i] - closes[i - 1];
      const signVal = diff > 0 ? 1 : diff < 0 ? -1 : 0;
      if (signVal === 0) break;
      if (lastSign === 0) {
        lastSign = signVal;
        streak = signVal > 0 ? 1 : -1;
        continue;
      }
      if (signVal === lastSign) {
        streak = signVal > 0 ? streak + 1 : streak - 1;
      } else {
        break;
      }
    }

    writeCache(cacheKey, streak, 30 * 60 * 1000);
    return streak;
  };

  const directSectorStreak = async (url) => {
    const listResp = await directSectorList();
    if (!listResp.success) throw new Error('sector list failed');
    const limit = Number(url.searchParams.get('limit') || 0);
    const sectors = limit ? listResp.data.slice(0, limit) : listResp.data;

    const streakMap = {};
    const poolSize = Math.min(10, Math.max(2, sectors.length));
    await runPool(sectors, poolSize, async (sector) => {
      try {
        const streak = await calcSectorStreak(sector.code);
        streakMap[sector.code] = streak;
      } catch (e) {
        streakMap[sector.code] = 0;
      }
    });

    return {
      success: true,
      data: sectors.map(s => ({ ...s, streak_days: streakMap[s.code] ?? 0 }))
    };
  };

  const tryDirectApi = async (url) => {
    const module = url.searchParams.get('module') || '';
    const action = url.searchParams.get('action') || '';
    const key = `${module}:${action}`;
    if (key === 'sector:list') return directSectorList();
    if (key === 'sector:streak') return directSectorStreak(url);
    return null;
  };

  const api = async (endpoint, params = {}, options = {}) => {
    const { force = false } = options;
    const url = new URL(endpoint, location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    
    const cacheKey = url.toString();
    if (!force) {
      const cached = readCache(cacheKey);
      if (cached && cached.success !== false) return cached;
    }

    try {
      const direct = await tryDirectApi(url);
      if (direct) {
        if (direct.success !== false) {
          writeCache(cacheKey, direct, getCacheTTL(url));
        }
        return direct;
      }
    } catch (e) {
      console.warn('Direct API failed, fallback to proxy:', e);
    }
    
    try {
      const resp = await fetch(url, { 
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000)
      });
      const data = await resp.json();
      
      if (data && data.success !== false) {
        writeCache(cacheKey, data, getCacheTTL(url));
      }
      return data;
    } catch (e) {
      console.error('API Error:', e);
      return { success: false, message: e.message || '网络错误' };
    }
  };

  // ==========================================
  // 页面渲染 - 持有
  // ==========================================
  
  const renderHoldTabs = () => {
    const tabs = $('headerTabs');
    if (!tabs) return;
    
    const allTabs = [
      { id: 'summary', name: '账户汇总' },
      { id: 'all', name: '全部' },
      ...state.accounts
    ];
    
    tabs.innerHTML = allTabs.map(tab => `
      <button class="header-tab ${state.currentAccount === tab.id ? 'active' : ''}" 
              data-account="${tab.id}">${tab.name}</button>
    `).join('') + `
      <button class="header-tab menu-btn" id="manageAccountBtn">☰</button>
    `;
    
    tabs.querySelectorAll('.header-tab[data-account]').forEach(btn => {
      btn.onclick = () => {
        state.currentAccount = btn.dataset.account;
        renderHoldTabs();
        renderHoldPage();
      };
    });
    
    $('manageAccountBtn').onclick = openAccountManageModal;
  };

  const renderHoldPage = async () => {
    const page = $('page-hold');
    if (!page) return;
    
    if (state.currentAccount === 'summary') {
      await renderAccountSummary(page);
    } else if (state.currentAccount === 'all') {
      await renderAllHoldings(page);
    } else {
      await renderAccountHoldings(page, state.currentAccount);
    }
  };

  const renderAccountSummary = async (page) => {
    const allCodes = [];
    Object.values(state.holdings).forEach(list => {
      list.forEach(h => {
        if (!allCodes.includes(h.code)) allCodes.push(h.code);
      });
    });
    
    let fundData = {};
    if (allCodes.length > 0) {
      const resp = await api(`${API}?module=fund`, { action: 'batch', codes: allCodes.join(',') });
      if (resp.success) {
        resp.data.forEach(f => { fundData[f.code] = f; });
      }
    }
    
    let totalAsset = 0;
    let totalProfit = 0;
    const accountStats = state.accounts.map(acc => {
      const holdings = state.holdings[acc.id] || [];
      let asset = 0, profit = 0, upCount = 0, downCount = 0;
      
      holdings.forEach(h => {
        asset += h.amount || 0;
        const fund = fundData[h.code];
        if (fund) {
          const change = parseFloat(fund.estimate_change) || 0;
          const dayProfit = (h.amount || 0) * change / 100;
          profit += dayProfit;
          if (change > 0) upCount++;
          else if (change < 0) downCount++;
        }
      });
      
      totalAsset += asset;
      totalProfit += profit;
      
      const holdProfit = holdings.reduce((sum, h) => sum + (h.profit || 0), 0);
      const holdProfitPct = asset > 0 ? (holdProfit / (asset - holdProfit) * 100) : 0;
      const dayProfitPct = asset > 0 ? (profit / asset * 100) : 0;
      
      return {
        ...acc,
        asset,
        holdProfit,
        holdProfitPct,
        dayProfit: profit,
        dayProfitPct,
        upCount,
        downCount,
        fundCount: holdings.length
      };
    });
    
    page.innerHTML = `
      <div class="account-section">
        <div class="account-label">账户资产</div>
        <div class="account-row">
          <div class="account-total">${fmt(totalAsset)}</div>
          <div class="account-profit">
            <div class="account-profit-value ${cls(totalProfit)}">${sign(totalProfit)}${fmt(totalProfit)}</div>
          </div>
        </div>
      </div>
      <div class="account-cards">
        ${accountStats.map(acc => `
          <div class="account-card" data-account="${acc.id}">
            <div class="account-card-header">
              <div class="account-card-name">${acc.name}</div>
              <div class="account-card-stats">
                <span class="stat-up">↑${acc.upCount}</span>
                <span class="stat-down">↓${acc.downCount}</span>
              </div>
            </div>
            <div class="account-card-body">
              <div class="account-card-item">
                <div class="account-card-item-label">账户资产</div>
                <div class="account-card-item-value">${fmt(acc.asset)}</div>
              </div>
              <div class="account-card-item">
                <div class="account-card-item-label">持有收益</div>
                <div class="account-card-item-value ${cls(acc.holdProfit)}">${sign(acc.holdProfit)}${fmt(acc.holdProfit)}</div>
              </div>
              <div class="account-card-item">
                <div class="account-card-item-label">当日收益</div>
                <div class="account-card-item-value ${cls(acc.dayProfit)}">${sign(acc.dayProfit)}${fmt(acc.dayProfit)}</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    page.querySelectorAll('.account-card').forEach(card => {
      card.onclick = () => {
        state.currentAccount = card.dataset.account;
        renderHoldTabs();
        renderHoldPage();
      };
    });
  };

  const renderAllHoldings = async (page) => {
    const allHoldings = [];
    Object.entries(state.holdings).forEach(([accId, list]) => {
      list.forEach(h => {
        const existing = allHoldings.find(x => x.code === h.code);
        if (existing) {
          existing.amount += h.amount || 0;
          existing.profit += h.profit || 0;
        } else {
          allHoldings.push({ ...h });
        }
      });
    });
    
    await renderFundList(page, allHoldings, null);
  };

  const renderAccountHoldings = async (page, accountId) => {
    const holdings = state.holdings[accountId] || [];
    await renderFundList(page, holdings, accountId);
  };

  const renderFundList = async (page, holdings, accountId) => {
    let totalAsset = holdings.reduce((sum, h) => sum + (h.amount || 0), 0);
    
    let fundData = {};
    const codes = holdings.map(h => h.code).filter(Boolean);
    if (codes.length > 0) {
      const resp = await api(`${API}?module=fund`, { action: 'batch', codes: codes.join(',') });
      if (resp.success) {
        resp.data.forEach(f => { fundData[f.code] = f; });
      }
    }
    
    let totalProfit = 0;
    const enrichedHoldings = holdings.map(h => {
      const fund = fundData[h.code] || {};
      const change = parseFloat(fund.estimate_change) || 0;
      const dayProfit = (h.amount || 0) * change / 100;
      totalProfit += dayProfit;
      return { ...h, ...fund, dayProfit, change };
    });
    
    // 排序
    const sortField = state.holdSort.field;
    const sortAsc = state.holdSort.asc;
    enrichedHoldings.sort((a, b) => {
      let va = sortField === 'profit' ? a.dayProfit : a.change;
      let vb = sortField === 'profit' ? b.dayProfit : b.change;
      return sortAsc ? va - vb : vb - va;
    });
    
    const profitActive = sortField === 'profit';
    const changeActive = sortField === 'change';
    
    page.innerHTML = `
      <div class="account-section">
        <div class="account-label">账户资产</div>
        <div class="account-row">
          <div class="account-total">${fmt(totalAsset)}</div>
          <div class="account-profit">
            <div class="account-profit-value ${cls(totalProfit)}">${sign(totalProfit)}${fmt(totalProfit)}</div>
          </div>
        </div>
      </div>
      <div class="list-header">
        <div class="list-header-col list-header-col-name">基金</div>
        <div class="list-header-col sortable ${profitActive ? 'active' : ''}" data-sort="profit">
          当日收益 ${profitActive ? (sortAsc ? '↑' : '↓') : ''}
        </div>
        <div class="list-header-col sortable ${changeActive ? 'active' : ''}" data-sort="change">
          当日涨幅 ${changeActive ? (sortAsc ? '↑' : '↓') : ''}
        </div>
      </div>
      <div class="fund-list">
        ${enrichedHoldings.length > 0 ? enrichedHoldings.map(h => `
          <div class="fund-item" data-code="${h.code}" data-name="${h.name || ''}">
            <div class="fund-info">
              <div class="fund-name">${h.name || h.code}</div>
              <div class="fund-meta">¥${fmt(h.amount)}</div>
            </div>
            <div class="fund-profit ${cls(h.dayProfit)}">${sign(h.dayProfit)}${fmt(h.dayProfit)}</div>
            <div class="fund-change ${cls(h.change)}">${sign(h.change)}${fmt(h.change)}%</div>
          </div>
        `).join('') : `
          <div class="empty">
            <div class="empty-icon">💰</div>
            <div class="empty-text">暂无持仓</div>
          </div>
        `}
      </div>
      ${accountId ? `
        <div class="fund-list-footer">
          <button class="add-holding-btn" data-account="${accountId}">+ 新增持有</button>
        </div>
      ` : ''}
    `;
    
    // 排序点击
    page.querySelectorAll('.sortable').forEach(el => {
      el.onclick = () => {
        const field = el.dataset.sort;
        if (state.holdSort.field === field) {
          state.holdSort.asc = !state.holdSort.asc;
        } else {
          state.holdSort.field = field;
          state.holdSort.asc = false;
        }
        renderFundList(page, holdings, accountId);
      };
    });
    
    page.querySelectorAll('.fund-item').forEach(item => {
      item.onclick = () => openFundDetail(item.dataset.code, item.dataset.name);
    });
    
    const addBtn = page.querySelector('.add-holding-btn');
    if (addBtn) {
      addBtn.onclick = () => openAddModal(addBtn.dataset.account);
    }
  };

  // ==========================================
  // 账户管理弹层
  // ==========================================
  
  const openAccountManageModal = () => {
    const modal = $('accountModal');
    if (!modal) return;
    
    modal.classList.add('active');
    renderAccountManage();
  };

  const closeAccountManageModal = () => {
    $('accountModal')?.classList.remove('active');
    renderHoldTabs();
    renderHoldPage();
  };

  const renderAccountManage = () => {
    const page = $('accountPage');
    if (!page) return;
    
    const canMoveUp = index => index > 0;
    const canMoveDown = index => index < state.accounts.length - 1;

    page.innerHTML = `
      <div class="modal-header">
        <button class="back-btn" id="accountBack">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <h1 class="modal-title">账户管理</h1>
        <button class="add-account-btn" id="addAccountBtn">添加</button>
      </div>
      <div class="account-manage-list">
        ${state.accounts.map((acc, i) => `
          <div class="account-manage-item" data-id="${acc.id}">
            <span class="account-manage-name">${acc.name}</span>
            <div class="account-manage-actions">
              <button class="account-move-btn" data-id="${acc.id}" data-move="up" ${canMoveUp(i) ? '' : 'disabled'}>上移</button>
              <button class="account-move-btn" data-id="${acc.id}" data-move="down" ${canMoveDown(i) ? '' : 'disabled'}>下移</button>
              <button class="account-edit-btn" data-id="${acc.id}" data-name="${acc.name}">编辑</button>
              ${state.accounts.length > 1 ? `<button class="account-delete-btn" data-id="${acc.id}">删除</button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    $('accountBack').onclick = closeAccountManageModal;
    $('addAccountBtn').onclick = () => {
      const name = prompt('请输入账户名称');
      if (name && name.trim()) {
        const id = 'acc_' + Date.now();
        state.accounts.push({ id, name: name.trim() });
        saveAccounts();
        renderAccountManage();
        toast('账户已添加');
      }
    };
    
    page.querySelectorAll('.account-edit-btn').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const oldName = btn.dataset.name;
        const newName = prompt('请输入新的账户名称', oldName);
        if (newName && newName.trim()) {
          const acc = state.accounts.find(a => a.id === id);
          if (acc) {
            acc.name = newName.trim();
            saveAccounts();
            renderAccountManage();
            toast('账户已更新');
          }
        }
      };
    });
    
    page.querySelectorAll('.account-delete-btn').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (confirm('确定要删除该账户吗？账户内的持仓数据也会被删除。')) {
          state.accounts = state.accounts.filter(a => a.id !== id);
          delete state.holdings[id];
          saveAccounts();
          saveHoldings();
          renderAccountManage();
          toast('账户已删除');
        }
      };
    });

    page.querySelectorAll('.account-move-btn').forEach(btn => {
      btn.onclick = () => {
        if (btn.disabled) return;
        const id = btn.dataset.id;
        const move = btn.dataset.move;
        const idx = state.accounts.findIndex(a => a.id === id);
        if (idx === -1) return;
        const targetIdx = move === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= state.accounts.length) return;
        const swapped = [...state.accounts];
        [swapped[idx], swapped[targetIdx]] = [swapped[targetIdx], swapped[idx]];
        state.accounts = swapped;
        saveAccounts();
        renderAccountManage();
      };
    });
  };

  // ==========================================
  // 页面渲染 - 自选
  // ==========================================
  
  const renderWatchPage = async () => {
    const page = $('page-watch');
    if (!page) return;
    
    let watchData = [];
    if (state.watchlist.length > 0) {
      const codes = state.watchlist.map(w => w.code).join(',');
      const resp = await api(`${API}?module=fund`, { action: 'batch', codes });
      if (resp.success) {
        watchData = resp.data;
      }
    }
    
    // 排序
    const sortAsc = state.watchSort.asc;
    const enrichedWatch = state.watchlist.map(w => {
      const data = watchData.find(d => d.code === w.code) || {};
      return { ...w, change: parseFloat(data.estimate_change) || 0 };
    });
    
    enrichedWatch.sort((a, b) => sortAsc ? a.change - b.change : b.change - a.change);
    
    page.innerHTML = `
      <div class="watch-header">
        <div class="watch-title-group">
          <div class="watch-title">自选基金</div>
          <div class="watch-subtitle">已关注 ${state.watchlist.length} 只</div>
        </div>
        <div class="watch-count-badge">${state.watchlist.length}</div>
      </div>
      <div class="list-header">
        <div class="list-header-col list-header-col-name">基金</div>
        <div class="list-header-col sortable active" id="watchSortBtn">
          当日涨幅 ${sortAsc ? '↑' : '↓'}
        </div>
      </div>
      <div class="watch-list">
        ${enrichedWatch.length > 0 ? enrichedWatch.map(w => `
          <div class="watch-item" data-code="${w.code}" data-name="${w.name || ''}">
            <div class="watch-info">
              <div class="watch-name">${w.name}</div>
              <div class="watch-code">${w.code}</div>
            </div>
            <div class="watch-change ${cls(w.change)}">${sign(w.change)}${fmt(w.change)}%</div>
          </div>
        `).join('') : `
          <div class="empty">
            <div class="empty-icon">⭐</div>
            <div class="empty-text">暂无自选</div>
            <div class="empty-hint">搜索基金添加到自选</div>
          </div>
        `}
      </div>
    `;
    
    $('watchSortBtn')?.addEventListener('click', () => {
      state.watchSort.asc = !state.watchSort.asc;
      renderWatchPage();
    });
    
    page.querySelectorAll('.watch-item').forEach(item => {
      item.onclick = () => openFundDetail(item.dataset.code, item.dataset.name);
    });
  };

  // ==========================================
  // 页面渲染 - 行情
  // ==========================================
  
  const renderMarketPage = async () => {
    const page = $('page-market');
    if (!page) return;
    
    page.innerHTML = `
      <div class="market-page">
        <div class="index-cards" id="indexCards">
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="sector-section" id="sectorSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;
    
    loadIndices();
    loadSectorSection();
  };

  const loadIndices = async (options = {}) => {
    const container = $('indexCards');
    if (!container) return;

    const resp = await api(
      `${API}?module=market`,
      { action: 'indices' },
      options
    );
    if (resp.success && resp.data.length > 0) {
      container.innerHTML = resp.data.map(idx => {
        const changeClass = cls(idx.change_percent) || 'flat';
        return `
        <div class="index-card ${changeClass}">
          <div class="index-card-name">${idx.name}</div>
          <div class="index-card-value">${idx.value}</div>
          <div class="index-card-change ${cls(idx.change_percent)}">${idx.change} ${idx.change_percent}</div>
        </div>
      `;
      }).join('');
      return;
    }

    container.innerHTML = `
      <div class="empty-inline">
        <div>指数数据加载失败</div>
        <button class="retry-btn" id="retryIndices">点击重试</button>
      </div>
    `;
    $('retryIndices')?.addEventListener('click', () => loadIndices({ force: true }));
  };

  const renderSectorOverview = (container, sectors) => {
    const sortField = state.sectorSort.field;
    const sortAsc = state.sectorSort.asc;
    const sorted = [...sectors];
    sorted.sort((a, b) => {
      let va, vb;
      if (sortField === 'change') {
        va = parseFloat(String(a.change_percent).replace('%', '').replace('+', '')) || 0;
        vb = parseFloat(String(b.change_percent).replace('%', '').replace('+', '')) || 0;
      } else {
        va = a.streak_days || 0;
        vb = b.streak_days || 0;
      }
      return sortAsc ? va - vb : vb - va;
    });

    const changeActive = sortField === 'change';
    const streakActive = sortField === 'streak';

    container.innerHTML = `
      <div class="section-header">
        <span class="section-title">板块总览</span>
      </div>
      <div class="sector-table-header">
        <span class="sector-col-name">板块名称</span>
        <span class="sector-col sortable ${changeActive ? 'active' : ''}" data-sort="change">
          当日涨幅 ${changeActive ? (sortAsc ? '↑' : '↓') : ''}
        </span>
        <span class="sector-col sortable ${streakActive ? 'active' : ''}" data-sort="streak">
          连涨天数 ${streakActive ? (sortAsc ? '↑' : '↓') : ''}
        </span>
      </div>
      <div class="sector-list">
        ${sorted.map(s => `
          <div class="sector-item" data-code="${s.code}" data-name="${s.name}">
            <div class="sector-info">
              <div class="sector-name">${s.name}</div>
            </div>
            <div class="sector-col-value ${cls(s.change_percent)}">${s.change_percent}</div>
            <div class="sector-col-value ${s.streak_days >= 0 ? 'rise' : 'fall'}">${s.streak_days}天</div>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelectorAll('.sortable').forEach(el => {
      el.onclick = () => {
        const field = el.dataset.sort;
        if (state.sectorSort.field === field) {
          state.sectorSort.asc = !state.sectorSort.asc;
        } else {
          state.sectorSort.field = field;
          state.sectorSort.asc = false;
        }
        renderSectorOverview(container, sectors);
      };
    });

    container.querySelectorAll('.sector-item').forEach(item => {
      item.onclick = () => openSectorFundsModal(item.dataset.code, item.dataset.name);
    });
  };

  const loadSectorSection = async (options = {}) => {
    const container = $('sectorSection');
    if (!container) return;

    if (!options.force && Array.isArray(state.sectorOverview) && state.sectorOverview.length > 0) {
      renderSectorOverview(container, state.sectorOverview);
      return;
    }

    const resp = await api(
      `${API}?module=sector`,
      { action: 'streak' },
      options
    );
    if (resp.success) {
      const sectors = (resp.data || []).filter(s => !isEmptySector(s.code));
      state.sectorOverview = sectors;
      renderSectorOverview(container, sectors);
    } else {
      container.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">${resp.message || '板块数据获取失败'}</div>
          <button class="retry-btn" id="retrySector">点击重试</button>
        </div>
      `;
      $('retrySector')?.addEventListener('click', () => loadSectorSection({ force: true }));
    }
  };

  // ==========================================
  // 页面渲染 - 资讯
  // ==========================================
  
  const renderNewsPage = async () => {
    const page = $('page-news');
    if (!page) return;
    
    page.innerHTML = `
      <div class="news-list" id="newsList">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;
    
    const resp = await api(`${API}?module=news`, { action: 'list' });
    const newsList = $('newsList');
    
    if (resp.success && resp.data.length > 0) {
      newsList.innerHTML = resp.data.map(news => `
        <div class="news-item" ${news.url ? `data-url="${news.url}"` : ''}>
          <div class="news-content">
            <div class="news-item-title">${news.title}</div>
            <div class="news-item-summary">${news.summary || ''}</div>
            <div class="news-item-meta">
              <span class="news-source">${news.source}</span>
              <span class="news-time">${news.time}</span>
            </div>
          </div>
        </div>
      `).join('');
      
      newsList.querySelectorAll('.news-item[data-url]').forEach(item => {
        item.onclick = () => {
          const url = item.dataset.url;
          if (url) window.open(url, '_blank');
        };
      });
    } else {
      newsList.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📰</div>
          <div class="empty-text">暂无资讯</div>
        </div>
      `;
    }
  };

  // ==========================================
  // 弹层 - 搜索
  // ==========================================
  
  let fundPickerCallback = null;

  const openSearchModal = (callback = null) => {
    fundPickerCallback = callback;
    const modal = $('searchModal');
    if (!modal) return;
    
    modal.classList.add('active');
    $('searchInput')?.focus();
    renderSearchContent();
  };

  const closeSearchModal = () => {
    $('searchModal')?.classList.remove('active');
    $('searchInput').value = '';
    $('searchClear').classList.remove('show');
    fundPickerCallback = null;
  };

  const renderSearchContent = () => {
    const historyList = $('historyList');
    const hotList = $('hotList');
    
    if (historyList) {
      historyList.innerHTML = state.searchHistory.slice(0, 8).map(h => `
        <button class="history-tag" data-keyword="${h}">${h}</button>
      `).join('') || '<span style="color:var(--text-muted);font-size:13px">暂无搜索历史</span>';
      
      historyList.querySelectorAll('.history-tag').forEach(btn => {
        btn.onclick = () => {
          $('searchInput').value = btn.dataset.keyword;
          doSearch(btn.dataset.keyword);
        };
      });
    }
    
    loadHotSearch();
  };

  const loadHotSearch = async () => {
    const hotList = $('hotList');
    if (!hotList) return;
    
    const resp = await api(`${API}?module=fund`, { action: 'hot' });
    if (resp.success) {
      const hotData = resp.data.filter(f => !isMoneyFund(f)).slice(0, 5);
      hotData.forEach(f => rememberFundName(f.code, f.name));
      hotList.innerHTML = hotData.map((f, i) => `
        <div class="hot-item" data-code="${f.code}" data-name="${f.name}">
          <span class="hot-rank">${i + 1}</span>
          <div class="hot-info">
            <div class="hot-name">${f.name}</div>
            <div class="hot-code">${f.code}</div>
          </div>
        </div>
      `).join('');
      
      hotList.querySelectorAll('.hot-item').forEach(item => {
        item.onclick = () => {
          const code = item.dataset.code;
          const name = item.dataset.name;
          addSearchHistory(name);
          if (fundPickerCallback) {
            fundPickerCallback(code, name);
            closeSearchModal();
          } else {
            openFundDetail(code, name);
          }
        };
      });
    }
  };

  let searchSeq = 0;

  const doSearch = debounce(async (keyword) => {
    const safeKeyword = (keyword || '').trim();
    if (!safeKeyword || safeKeyword.length < 1) {
      // 取消未完成的搜索请求，避免旧结果覆盖
      searchSeq += 1;
      $('searchResults').style.display = 'none';
      $('searchHistory').style.display = 'block';
      $('searchHot').style.display = 'block';
      return;
    }
    const currentSeq = ++searchSeq;
    
    $('searchHistory').style.display = 'none';
    $('searchHot').style.display = 'none';
    
    const results = $('searchResults');
    results.style.display = 'block';
    results.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    const resp = await api(`${API}?module=fund`, { action: 'search', keyword: safeKeyword });
    if (currentSeq !== searchSeq || $('searchInput').value.trim() !== safeKeyword) {
      return;
    }
    
    const safeData = resp.success ? resp.data.filter(f => !isMoneyFund(f)) : [];
    if (resp.success && safeData.length > 0) {
      safeData.forEach(f => rememberFundName(f.code, f.name));
      results.innerHTML = safeData.map(f => `
        <div class="result-item" data-code="${f.code}" data-name="${f.name}">
          <div class="result-icon">基</div>
          <div class="result-info">
            <div class="result-name">${f.name}</div>
            <div class="result-meta">
              ${f.code}
              ${[f.category, f.type].filter(Boolean).map(tag => `<span class="result-tag">${tag}</span>`).join('')}
            </div>
          </div>
          <button class="result-action ${state.watchlist.some(w => w.code === f.code) ? 'added' : ''}" 
                  data-code="${f.code}" data-name="${f.name}">
            ${state.watchlist.some(w => w.code === f.code) ? '已自选' : '加自选'}
          </button>
        </div>
      `).join('');
      
      results.querySelectorAll('.result-item').forEach(item => {
        item.onclick = (e) => {
          if (e.target.classList.contains('result-action')) return;
          const code = item.dataset.code;
          const name = item.dataset.name;
          addSearchHistory(name);
          if (fundPickerCallback) {
            fundPickerCallback(code, name);
            closeSearchModal();
          } else {
            openFundDetail(code, name);
          }
        };
      });
      
      results.querySelectorAll('.result-action').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          if (btn.classList.contains('added')) return;
          
          const code = btn.dataset.code;
          const name = btn.dataset.name;
          addToWatchlist(code, name);
          btn.classList.add('added');
          btn.textContent = '已自选';
          toast('已添加到自选');
        };
      });
    } else {
      results.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🔍</div>
          <div class="empty-text">未找到相关基金</div>
        </div>
      `;
    }
  }, 300);

  const addSearchHistory = (keyword) => {
    if (!keyword) return;
    state.searchHistory = [keyword, ...state.searchHistory.filter(h => h !== keyword)].slice(0, 20);
    saveSearchHistory();
  };

  // ==========================================
  // 弹层 - 新增持有
  // ==========================================
  
  let addFormItems = [];
  let addTargetAccount = null;

  const openAddModal = (accountId) => {
    addTargetAccount = accountId || (state.accounts[0]?.id);
    addFormItems = [{ code: '', name: '', amount: '', profit: '' }];
    renderAddForm();
    $('addModal')?.classList.add('active');
  };

  const closeAddModal = () => {
    $('addModal')?.classList.remove('active');
    addFormItems = [];
    addTargetAccount = null;
  };

  const renderAddForm = () => {
    const form = $('addForm');
    const accountSelect = $('accountSelect');
    if (!form) return;
    
    // 渲染账户选择器
    if (accountSelect) {
      accountSelect.innerHTML = state.accounts.map(acc => `
        <option value="${acc.id}" ${acc.id === addTargetAccount ? 'selected' : ''}>${acc.name}</option>
      `).join('');
      accountSelect.onchange = () => { addTargetAccount = accountSelect.value; };
    }
    
    form.innerHTML = addFormItems.map((item, i) => `
      <div class="add-form-item" data-index="${i}">
        ${addFormItems.length > 1 ? `<button class="add-form-close" data-index="${i}">×</button>` : ''}
        <div class="add-form-row">
          <label class="add-form-label">基金代码</label>
          <input type="text" class="add-form-input code-input" 
                 data-index="${i}" 
                 placeholder="输入6位基金代码或点击搜索" 
                 value="${item.code || ''}"
                 maxlength="6">
          <button class="search-fund-btn" data-index="${i}">搜索</button>
        </div>
        ${item.name ? `<div class="add-form-fund-name">${item.name}</div>` : ''}
        <div class="add-form-row">
          <label class="add-form-label">持有金额</label>
          <input type="number" class="add-form-input amount-input" 
                 data-index="${i}" 
                 placeholder="请输入持有金额" 
                 value="${item.amount || ''}" inputmode="decimal">
        </div>
        <div class="add-form-row">
          <label class="add-form-label">持有收益</label>
          <input type="number" class="add-form-input profit-input" 
                 data-index="${i}" 
                 placeholder="请输入持有收益（可选）" 
                 value="${item.profit || ''}" inputmode="decimal">
        </div>
      </div>
    `).join('');
    
    updateSubmitBtn();
    
    form.querySelectorAll('.add-form-close').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        addFormItems.splice(idx, 1);
        renderAddForm();
      };
    });
    
    form.querySelectorAll('.code-input').forEach(input => {
      input.oninput = async () => {
        const idx = parseInt(input.dataset.index);
        addFormItems[idx].code = input.value;
        
        // 自动搜索基金名称
        if (input.value.length === 6) {
          const resp = await api(`${API}?module=fund`, { action: 'info', code: input.value });
          if (resp.success) {
            addFormItems[idx].name = resp.data.name;
            renderAddForm();
          }
        }
        updateSubmitBtn();
      };
    });
    
    form.querySelectorAll('.search-fund-btn').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        openSearchModal((code, name) => {
          addFormItems[idx].code = code;
          addFormItems[idx].name = name;
          renderAddForm();
        });
      };
    });
    
    form.querySelectorAll('.amount-input, .profit-input').forEach(input => {
      input.oninput = () => {
        const idx = parseInt(input.dataset.index);
        if (input.classList.contains('amount-input')) {
          addFormItems[idx].amount = input.value;
        } else {
          addFormItems[idx].profit = input.value;
        }
        updateSubmitBtn();
      };
    });
  };

  const updateSubmitBtn = () => {
    const validCount = addFormItems.filter(item => 
      item.code && item.code.length === 6 && item.amount && parseFloat(item.amount) > 0
    ).length;
    
    const btn = $('submitBtn');
    if (btn) {
      btn.textContent = `完成 (${validCount})`;
      btn.classList.toggle('active', validCount > 0);
    }
  };

  const submitAddForm = () => {
    const validItems = addFormItems.filter(item => 
      item.code && item.code.length === 6 && item.amount && parseFloat(item.amount) > 0
    );
    
    if (validItems.length === 0) {
      toast('请填写完整信息');
      return;
    }
    
    if (!state.holdings[addTargetAccount]) {
      state.holdings[addTargetAccount] = [];
    }
    
    validItems.forEach(item => {
      const existing = state.holdings[addTargetAccount].find(h => h.code === item.code);
      if (existing) {
        existing.amount = parseFloat(item.amount);
        existing.profit = parseFloat(item.profit) || 0;
        existing.name = item.name || existing.name;
      } else {
        state.holdings[addTargetAccount].push({
          code: item.code,
          name: item.name || item.code,
          amount: parseFloat(item.amount),
          profit: parseFloat(item.profit) || 0
        });
      }
    });
    
    saveHoldings();
    closeAddModal();
    toast(`已添加 ${validItems.length} 只基金`);
    renderHoldPage();
  };

  // ==========================================
  // 弹层 - 基金详情
  // ==========================================
  
  let detailSeq = 0;
  const formatPercent = (value) => {
    if (value === undefined || value === null || value === '') return '--';
    const num = parseFloat(String(value).replace('%', '').replace('+', ''));
    if (isNaN(num)) return '--';
    return `${sign(num)}${num}%`;
  };

  const openFundDetail = async (code, nameHint = '', options = {}) => {
    const modal = $('detailModal');
    const page = $('detailPage');
    if (!modal || !page) return;
    const currentSeq = ++detailSeq;
    const { force = false } = options;
    
    modal.classList.add('active');
    state.detailTab = 'stocks';
    const resolvedName = getFundNameHint(code, nameHint) || code;
    
    const renderDetail = (fund, { loadingDetails = false, loadingBase = false } = {}) => {
      const displayName = (fund.name || resolvedName || code).trim();
      const estimateText = formatPercent(fund.estimate_change);
      const yearText = formatPercent(fund.year_change);
      const estimateClass = estimateText === '--' ? '' : cls(fund.estimate_change);
      const yearClass = yearText === '--' ? '' : cls(fund.year_change);
      const fundCode = fund.code || code;
      const perfCmp = formatMultiline(fund.perf_cmp);
      const invTgt = formatMultiline(fund.inv_tgt);
      const hasFundIntro = !!(perfCmp || invTgt);
      const availableTabs = ['stocks', 'intro'];
      let activeTab = state.detailTab;
      if (!availableTabs.includes(activeTab)) {
        activeTab = availableTabs[0];
        state.detailTab = activeTab;
      }
      
      page.innerHTML = `
        <div class="detail-header">
          <button class="back-btn" id="detailBack">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div class="detail-title-wrap">
            <div class="detail-title">${displayName}</div>
            <div class="detail-code">${fundCode}</div>
          </div>
        </div>
        
        <div class="detail-content">
          <div class="detail-valuation">
            <div class="valuation-main">
              <div class="valuation-label">当日涨幅（估）</div>
              <div class="valuation-value ${estimateClass}">${estimateText}</div>
            </div>
            <div class="valuation-info">
              <div class="valuation-item">
                <div class="valuation-item-label">近1年涨幅</div>
                <div class="valuation-item-value ${yearClass}">${yearText}</div>
              </div>
              <div class="valuation-item">
                <div class="valuation-item-label">最新净值</div>
                <div class="valuation-item-value">${fund.nav || '--'}</div>
              </div>
              <div class="valuation-item">
                <div class="valuation-item-label">估算时间</div>
                <div class="valuation-item-value">${fund.estimate_time || '--'}</div>
              </div>
            </div>
          </div>
          
          ${loadingDetails ? `
            <div class="detail-sectors">
              <div class="detail-section-title">关联板块</div>
              <div class="empty-inline">加载中...</div>
            </div>
          ` : (fund.sectors && fund.sectors.length > 0 ? `
            <div class="detail-sectors">
              <div class="detail-section-title">关联板块</div>
              <div class="sector-tags">
                ${fund.sectors.map(s => `
                  <span class="sector-tag" data-code="${s.code}" data-name="${s.name}">${s.name}</span>
                `).join('')}
              </div>
            </div>
          ` : '')}

          <div class="detail-tab-card">
            <div class="detail-tabs">
              <button class="detail-tab ${activeTab === 'stocks' ? 'active' : ''}" data-tab="stocks">基金重仓股</button>
              <button class="detail-tab ${activeTab === 'intro' ? 'active' : ''}" data-tab="intro">基金概要</button>
            </div>
            <div class="detail-tab-panels">
              <div class="detail-tab-panel ${activeTab === 'stocks' ? '' : 'is-hidden'}">
                <div class="detail-stocks">
                  ${loadingDetails ? `
                    <div class="empty-inline">加载中...</div>
                  ` : (fund.stocks && fund.stocks.length > 0 ? `
                    <div class="stocks-list">
                      ${fund.stocks.map((s, i) => `
                        <div class="stock-item">
                          <span class="stock-rank">${i + 1}</span>
                          <div class="stock-info">
                            <div class="stock-name">${s.name}</div>
                            <div class="stock-code">${s.code}</div>
                          </div>
                          <div class="stock-metrics">
                            <div class="stock-ratio">${s.ratio}</div>
                            <div class="stock-change ${cls(s.change)}">${s.change !== undefined && s.change !== null && s.change !== '' ? `${sign(s.change)}${fmt(s.change)}%` : '--'}</div>
                          </div>
                        </div>
                      `).join('')}
                    </div>
                  ` : `
                    <div class="empty-inline">暂无重仓股数据</div>
                  `)}
                </div>
              </div>
              <div class="detail-tab-panel ${activeTab === 'intro' ? '' : 'is-hidden'}">
                ${loadingDetails && !hasFundIntro ? `
                  <div class="empty-inline">加载中...</div>
                ` : (hasFundIntro ? `
                  <div class="detail-info">
                    <div class="detail-info-item">
                      <div class="detail-info-label">业绩比较基准</div>
                      <div class="detail-info-content">${perfCmp || '--'}</div>
                    </div>
                    <div class="detail-info-item">
                      <div class="detail-info-label">投资目标</div>
                      <div class="detail-info-content">${invTgt || '--'}</div>
                    </div>
                  </div>
                ` : `
                  <div class="empty-inline">暂无概要信息</div>
                `)}
              </div>
            </div>
          </div>
          
        </div>
        
        ${loadingBase ? `
          <div class="loading" style="padding:16px 0"><div class="spinner"></div></div>
        ` : ''}
        <div class="detail-actions">
          <button class="detail-action primary" id="editHoldingBtn">
            ${Object.values(state.holdings).some(list => list.some(h => h.code === fundCode)) ? '修改持仓' : '添加持有'}
          </button>
          <button class="detail-action ${state.watchlist.some(w => w.code === fundCode) ? 'danger' : ''}" id="toggleWatchBtn">
            ${state.watchlist.some(w => w.code === fundCode) ? '删自选' : '加自选'}
          </button>
        </div>
      `;
      
      $('detailBack').onclick = closeDetailModal;

      page.querySelectorAll('.detail-tab').forEach(tab => {
        tab.onclick = () => {
          state.detailTab = tab.dataset.tab;
          renderDetail(fund, { loadingDetails, loadingBase });
        };
      });
      
      page.querySelectorAll('.sector-tag').forEach(tag => {
        tag.onclick = () => {
          closeDetailModal();
          openSectorFundsModal(tag.dataset.code, tag.dataset.name);
        };
      });
      
      $('toggleWatchBtn').onclick = () => {
        const displayName = fund.name || resolvedName || fundCode;
        if (state.watchlist.some(w => w.code === fundCode)) {
          removeFromWatchlist(fundCode);
        } else {
          addToWatchlist(fundCode, displayName);
        }
        openFundDetail(code, displayName);
      };
      
      $('editHoldingBtn').onclick = () => {
        closeDetailModal();
        const displayName = fund.name || resolvedName || fundCode;
        // 打开新增持有弹层，预填基金信息
        const defaultAccount = state.accounts[0]?.id;
        addTargetAccount = defaultAccount;
        addFormItems = [{ code: fundCode, name: displayName, amount: '', profit: '' }];
        
        for (const [accId, list] of Object.entries(state.holdings)) {
          const existing = list.find(h => h.code === fundCode);
          if (existing) {
            addTargetAccount = accId;
            addFormItems[0].amount = existing.amount;
            addFormItems[0].profit = existing.profit;
            break;
          }
        }
        
        renderAddForm();
        $('addModal')?.classList.add('active');
      };
    };
    
    renderDetail({ code, name: resolvedName }, { loadingDetails: true, loadingBase: true });
    
    // 先拉取轻量信息，缩短首屏等待
    const infoPromise = api(
      `${API}?module=fund`,
      { action: 'info', code },
      { force }
    ).catch(() => null);
    const detailPromise = api(
      `${API}?module=fund`,
      { action: 'detail', code },
      { force }
    ).catch(() => null);
    
    const infoResp = await infoPromise;
    if (currentSeq !== detailSeq) return;
    if (infoResp?.success) {
      rememberFundName(code, infoResp.data?.name);
      renderDetail(infoResp.data || { code, name: resolvedName }, { loadingDetails: true });
    }
    
    const resp = await detailPromise;
    if (currentSeq !== detailSeq) return;
    
    if (!resp?.success) {
      page.innerHTML = `
        <div class="detail-header">
          <button class="back-btn" id="detailBack">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div class="detail-title-wrap">
            <div class="detail-title">${resolvedName || code}</div>
          </div>
        </div>
        <div class="empty" style="padding-top:100px">
          <div class="empty-icon">❌</div>
          <div class="empty-text">${resp?.message || '获取失败'}</div>
          <button class="retry-btn" id="retryDetail">点击重试</button>
        </div>
      `;
      $('detailBack').onclick = closeDetailModal;
      $('retryDetail')?.addEventListener('click', () => openFundDetail(code, resolvedName, { force: true }));
      return;
    }
    
    const fund = resp.data;
    rememberFundName(code, fund?.name);
    renderDetail(fund, { loadingDetails: false });
  };

  const closeDetailModal = () => {
    // 关闭时中断未完成的详情请求
    detailSeq += 1;
    $('detailModal')?.classList.remove('active');
  };

  // ==========================================
  // 弹层 - 板块基金
  // ==========================================
  
  const openSectorFundsModal = async (sectorCode, sectorName, options = {}) => {
    const modal = $('sectorFundsModal');
    const page = $('sectorFundsPage');
    if (!modal || !page) return;
    const { force = false } = options;
    
    modal.classList.add('active');
    page.innerHTML = `
      <div class="modal-header">
        <button class="back-btn" id="sectorFundsBack">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <h1 class="modal-title">${sectorName}</h1>
      </div>
      <div class="sector-funds-content">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;
    
    $('sectorFundsBack').onclick = closeSectorFundsModal;
    
    const resp = await api(
      `${API}?module=sector`,
      { action: 'funds', code: sectorCode, name: sectorName },
      { force }
    );
    const content = page.querySelector('.sector-funds-content');
    
    if (resp.success && resp.data.length > 0) {
      content.innerHTML = `
        <div class="list-header">
          <div class="list-header-col list-header-col-name">基金</div>
          <div class="list-header-col">当日涨幅</div>
        </div>
        <div class="fund-list">
          ${resp.data.map(f => `
            <div class="fund-item" data-code="${f.code}" data-name="${f.name || ''}">
              <div class="fund-info">
                <div class="fund-name">${f.name}</div>
                <div class="fund-meta">${f.code}</div>
              </div>
              <div class="fund-change ${cls(f.change)}">${f.change !== undefined && f.change !== null && f.change !== '' ? `${sign(parseFloat(f.change))}${fmt(f.change)}%` : '--'}</div>
            </div>
          `).join('')}
        </div>
      `;
      
      content.querySelectorAll('.fund-item').forEach(item => {
        item.onclick = () => {
          closeSectorFundsModal();
          openFundDetail(item.dataset.code, item.dataset.name);
        };
      });
    } else if (!resp.success) {
      content.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">${resp.message || '板块基金获取失败'}</div>
          <button class="retry-btn" id="retrySectorFunds">点击重试</button>
        </div>
      `;
      $('retrySectorFunds')?.addEventListener('click', () => openSectorFundsModal(sectorCode, sectorName, { force: true }));
    } else {
      // 无真实基金数据的板块直接标记，后续从列表移除
      markEmptySector(sectorCode, sectorName);
      loadSectorSection();
      content.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">暂无该板块基金数据，已从列表移除</div>
        </div>
      `;
    }
  };

  const closeSectorFundsModal = () => {
    $('sectorFundsModal')?.classList.remove('active');
  };

  // ==========================================
  // 自选管理
  // ==========================================
  
  const addToWatchlist = (code, name) => {
    if (!code || state.watchlist.some(w => w.code === code)) return;
    rememberFundName(code, name);
    state.watchlist.unshift({ code, name });
    saveWatchlist();
    toast('已添加到自选');
  };

  const removeFromWatchlist = (code) => {
    state.watchlist = state.watchlist.filter(w => w.code !== code);
    saveWatchlist();
    toast('已从自选移除');
  };

  // ==========================================
  // 页面切换
  // ==========================================
  
  const switchPage = (pageId) => {
    state.currentPage = pageId;
    const headerTitle = $('headerTitle');
    const headerTabs = $('headerTabs');
    const searchBtn = $('searchBtn');
    const tabNames = {
      hold: '持有',
      watch: '自选',
      market: '行情',
      news: '资讯'
    };
    
    $$('.tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === pageId);
    });
    
    $$('.page').forEach(page => {
      page.classList.toggle('active', page.dataset.page === pageId);
    });
    
    if (pageId === 'hold') {
      headerTitle?.classList.add('is-hidden');
      headerTabs?.classList.remove('is-hidden');
      searchBtn?.classList.remove('is-hidden');
      renderHoldTabs();
    } else {
      if (headerTitle) {
        headerTitle.textContent = tabNames[pageId] || '';
        headerTitle.classList.remove('is-hidden');
      }
      headerTabs?.classList.add('is-hidden');
      if (headerTabs) headerTabs.innerHTML = '';
      searchBtn?.classList.add('is-hidden');
    }
    
    switch (pageId) {
      case 'hold':
        renderHoldPage();
        break;
      case 'watch':
        renderWatchPage();
        break;
      case 'market':
        renderMarketPage();
        break;
      case 'news':
        renderNewsPage();
        break;
    }
    
    $('indexBar').style.display = (pageId === 'hold' || pageId === 'watch') ? 'flex' : 'none';
  };

  // ==========================================
  // 初始化
  // ==========================================
  
  const init = () => {
    loadState();
    
    $$('.tab').forEach(tab => {
      tab.onclick = () => switchPage(tab.dataset.tab);
    });
    
    $('searchBtn')?.addEventListener('click', () => openSearchModal());
    $('searchBack')?.addEventListener('click', closeSearchModal);
    $('searchCancel')?.addEventListener('click', closeSearchModal);
    
    $('searchInput')?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      $('searchClear').classList.toggle('show', val.length > 0);
      doSearch(val);
    });
    
    $('searchClear')?.addEventListener('click', () => {
      $('searchInput').value = '';
      $('searchClear').classList.remove('show');
      doSearch('');
    });
    
    $('clearHistory')?.addEventListener('click', () => {
      state.searchHistory = [];
      saveSearchHistory();
      renderSearchContent();
    });
    
    $('addBack')?.addEventListener('click', closeAddModal);
    $('addMore')?.addEventListener('click', () => {
      addFormItems.push({ code: '', name: '', amount: '', profit: '' });
      renderAddForm();
    });
    $('submitBtn')?.addEventListener('click', submitAddForm);
    
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // 主动检查更新并让新 SW 尽快生效，避免旧资源缓存
        reg.update().catch(() => {});
        if (reg.waiting) {
          reg.waiting.postMessage('skipWaiting');
        }
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage('skipWaiting');
            }
          });
        });
      }).catch(() => {});

      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    
    switchPage('hold');
    loadIndices();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
