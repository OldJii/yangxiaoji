/**
 * 养小基 - 主应用逻辑
 * 高性能PWA基金管理应用
 */

(function() {
  'use strict';

  // ==========================================
  // 配置与常量
  // ==========================================
  
  const API = '/api';
  const CACHE_TTL = 30 * 1000; // 30秒缓存
  const STORAGE_KEYS = {
    holdings: 'yxj_holdings',
    watchlist: 'yxj_watchlist',
    accounts: 'yxj_accounts',
    searchHistory: 'yxj_search_history',
    cache: 'yxj_cache'
  };

  // ==========================================
  // 状态管理
  // ==========================================
  
  const state = {
    currentPage: 'hold',
    currentAccount: 'summary', // summary, all, 或账户ID
    accounts: [],    // 用户账户列表
    holdings: {},    // 持仓数据 {accountId: [{code, name, amount, profit}]}
    watchlist: [],   // 自选列表 [{code, name}]
    cache: {},       // API缓存
    searchHistory: [],
    loading: {}
  };

  // ==========================================
  // 工具函数
  // ==========================================
  
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  
  const fmt = (n, decimals = 2) => {
    if (typeof n !== 'number' || isNaN(n)) return '--';
    return n.toLocaleString('zh-CN', { 
      minimumFractionDigits: decimals, 
      maximumFractionDigits: decimals 
    });
  };
  
  const sign = n => {
    if (typeof n !== 'number' || isNaN(n)) return '';
    return n >= 0 ? '+' : '';
  };
  
  const cls = v => {
    const n = parseFloat(String(v).replace('%', ''));
    if (isNaN(n)) return '';
    return n > 0 ? 'rise' : n < 0 ? 'fall' : '';
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
      { id: 'boduan', name: '波段' },
      { id: 'changchi', name: '长持' },
      { id: 'wenjian', name: '稳健' },
      { id: 'daiqingcang', name: '待清仓' }
    ]);
    state.holdings = storage.get(STORAGE_KEYS.holdings, {});
    state.watchlist = storage.get(STORAGE_KEYS.watchlist, []);
    state.searchHistory = storage.get(STORAGE_KEYS.searchHistory, []);
  };

  const saveHoldings = () => storage.set(STORAGE_KEYS.holdings, state.holdings);
  const saveWatchlist = () => storage.set(STORAGE_KEYS.watchlist, state.watchlist);
  const saveAccounts = () => storage.set(STORAGE_KEYS.accounts, state.accounts);
  const saveSearchHistory = () => storage.set(STORAGE_KEYS.searchHistory, state.searchHistory);

  // ==========================================
  // API 请求
  // ==========================================
  
  const api = async (endpoint, params = {}) => {
    const url = new URL(endpoint, location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    
    // 检查缓存
    const cacheKey = url.toString();
    const cached = state.cache[cacheKey];
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data;
    }
    
    try {
      const resp = await fetch(url, { 
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      const data = await resp.json();
      
      // 更新缓存
      state.cache[cacheKey] = { data, ts: Date.now() };
      
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
      <button class="header-tab" id="addAccountBtn">+</button>
      <button class="header-tab" id="manageAccountBtn">☰</button>
    `;
    
    // 绑定事件
    tabs.querySelectorAll('.header-tab[data-account]').forEach(btn => {
      btn.onclick = () => {
        state.currentAccount = btn.dataset.account;
        renderHoldTabs();
        renderHoldPage();
      };
    });
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
    // 计算所有账户的汇总数据
    const allCodes = [];
    Object.values(state.holdings).forEach(list => {
      list.forEach(h => {
        if (!allCodes.includes(h.code)) allCodes.push(h.code);
      });
    });
    
    let fundData = {};
    if (allCodes.length > 0) {
      const resp = await api(`${API}/fund`, { action: 'batch', codes: allCodes.join(',') });
      if (resp.success) {
        resp.data.forEach(f => { fundData[f.code] = f; });
      }
    }
    
    // 计算各账户数据
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
        downCount
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
              <div class="account-card-name">
                <div class="account-card-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  </svg>
                </div>
                ${acc.name}
              </div>
              <div class="account-card-stats">
                <span class="stat-up">↑ ${acc.upCount}</span>
                <span class="stat-down">↓ ${acc.downCount}</span>
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
                <div class="account-card-item-sub ${cls(acc.holdProfitPct)}">${sign(acc.holdProfitPct)}${fmt(acc.holdProfitPct)}%</div>
              </div>
              <div class="account-card-item">
                <div class="account-card-item-label">当日收益</div>
                <div class="account-card-item-value ${cls(acc.dayProfit)}">${sign(acc.dayProfit)}${fmt(acc.dayProfit)}</div>
                <div class="account-card-item-sub ${cls(acc.dayProfitPct)}">${sign(acc.dayProfitPct)}${fmt(acc.dayProfitPct)}%</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    // 绑定账户卡片点击
    page.querySelectorAll('.account-card').forEach(card => {
      card.onclick = () => {
        state.currentAccount = card.dataset.account;
        renderHoldTabs();
        renderHoldPage();
      };
    });
  };

  const renderAllHoldings = async (page) => {
    // 收集所有持仓
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
    
    await renderFundList(page, allHoldings, false);
  };

  const renderAccountHoldings = async (page, accountId) => {
    const holdings = state.holdings[accountId] || [];
    await renderFundList(page, holdings, true, accountId);
  };

  const renderFundList = async (page, holdings, showAddBtn, accountId = null) => {
    // 计算总资产
    let totalAsset = holdings.reduce((sum, h) => sum + (h.amount || 0), 0);
    
    // 获取实时估值
    let fundData = {};
    const codes = holdings.map(h => h.code).filter(Boolean);
    if (codes.length > 0) {
      const resp = await api(`${API}/fund`, { action: 'batch', codes: codes.join(',') });
      if (resp.success) {
        resp.data.forEach(f => { fundData[f.code] = f; });
      }
    }
    
    // 计算收益
    let totalProfit = 0;
    const enrichedHoldings = holdings.map(h => {
      const fund = fundData[h.code] || {};
      const change = parseFloat(fund.estimate_change) || 0;
      const dayProfit = (h.amount || 0) * change / 100;
      totalProfit += dayProfit;
      return { ...h, ...fund, dayProfit, change };
    });
    
    // 按收益排序
    enrichedHoldings.sort((a, b) => b.dayProfit - a.dayProfit);
    
    const today = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    
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
        <div class="list-header-left">
          <span class="list-header-icon">⚙️</span>
          <span class="list-header-icon">📊</span>
          <span class="list-header-icon">👤</span>
          <span class="list-header-icon">≡</span>
        </div>
        <div class="list-header-right">
          <div class="list-header-col">
            <div class="list-header-col-label">当日收益</div>
            <div class="list-header-col-date">${today}</div>
          </div>
          <div class="list-header-col">
            <div class="list-header-col-label">当日涨幅</div>
            <div class="list-header-col-date">${today}</div>
          </div>
        </div>
      </div>
      <div class="fund-list">
        ${enrichedHoldings.length > 0 ? enrichedHoldings.map(h => `
          <div class="fund-item" data-code="${h.code}">
            <div class="fund-info">
              <div class="fund-name">${h.name || h.code}</div>
              <div class="fund-meta">
                <span class="fund-amount">¥ ${fmt(h.amount)}</span>
              </div>
            </div>
            <div class="fund-profit">
              <div class="fund-profit-value ${cls(h.dayProfit)}">${sign(h.dayProfit)}${fmt(h.dayProfit)}</div>
            </div>
            <div class="fund-change ${cls(h.change)}">${sign(h.change)}${fmt(h.change)}%</div>
          </div>
        `).join('') : `
          <div class="empty">
            <div class="empty-icon">💰</div>
            <div class="empty-text">暂无持仓</div>
          </div>
        `}
      </div>
      ${showAddBtn ? `
        <button class="add-holding-btn" data-account="${accountId}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          新增持有
        </button>
      ` : ''}
    `;
    
    // 绑定基金项点击
    page.querySelectorAll('.fund-item').forEach(item => {
      item.onclick = () => openFundDetail(item.dataset.code);
    });
    
    // 绑定新增按钮
    const addBtn = page.querySelector('.add-holding-btn');
    if (addBtn) {
      addBtn.onclick = () => openAddModal(addBtn.dataset.account);
    }
  };

  // ==========================================
  // 页面渲染 - 自选
  // ==========================================
  
  const renderWatchPage = async () => {
    const page = $('page-watch');
    if (!page) return;
    
    // 获取板块数据
    const sectorResp = await api(`${API}/sector`, { action: 'streak' });
    const sectors = sectorResp.success ? sectorResp.data.slice(0, 5) : [];
    
    // 获取自选基金估值
    let watchData = [];
    if (state.watchlist.length > 0) {
      const codes = state.watchlist.map(w => w.code).join(',');
      const resp = await api(`${API}/fund`, { action: 'batch', codes });
      if (resp.success) {
        watchData = resp.data;
      }
    }
    
    page.innerHTML = `
      <div class="sector-entry">
        <div class="sector-entry-header">
          <span class="section-title">板块总览</span>
          <span class="sector-entry-arrow" id="openSectorBtn">›</span>
        </div>
        ${sectors.map(s => `
          <div class="sector-entry-item">
            <div class="sector-entry-info">
              <div class="sector-entry-name">${s.name}</div>
              <div class="sector-entry-count">${s.funds}只基金</div>
            </div>
            <div class="sector-entry-streak ${s.streak_days >= 0 ? 'rise' : 'fall'}">
              ${s.streak_days >= 0 ? '连涨' : '连跌'} ${Math.abs(s.streak_days)} 天
            </div>
            <div class="sector-entry-change ${cls(s.change_percent)}">${s.change_percent}</div>
          </div>
        `).join('')}
      </div>
      
      <div class="watch-section">
        <div class="watch-header">
          <span class="watch-title">自选风向标</span>
          <span class="sector-entry-arrow">›</span>
        </div>
        ${state.watchlist.length > 0 ? state.watchlist.map((w, i) => {
          const data = watchData.find(d => d.code === w.code) || {};
          return `
            <div class="watch-item" data-code="${w.code}">
              <span class="watch-rank">${i + 1}</span>
              <div class="watch-info">
                <div class="watch-name">${w.name}</div>
                <div class="watch-code">${w.code}</div>
              </div>
              <div class="watch-change ${cls(data.estimate_change)}">${data.estimate_change || '0.00'}%</div>
            </div>
          `;
        }).join('') : `
          <div class="empty">
            <div class="empty-icon">⭐</div>
            <div class="empty-text">暂无自选</div>
          </div>
        `}
      </div>
    `;
    
    // 绑定事件
    $('openSectorBtn')?.addEventListener('click', openSectorModal);
    page.querySelectorAll('.watch-item').forEach(item => {
      item.onclick = () => openFundDetail(item.dataset.code);
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
        <div class="distribution-section" id="distributionSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="fund-section" id="hotFundsSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="sector-entry" id="sectorEntrySection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;
    
    // 并行加载数据
    Promise.all([
      loadIndices(),
      loadDistribution(),
      loadHotFunds(),
      loadSectorEntry()
    ]);
  };

  const loadIndices = async () => {
    const container = $('indexCards');
    if (!container) return;
    
    const resp = await api(`${API}/market`, { action: 'indices' });
    if (resp.success && resp.data.length > 0) {
      container.innerHTML = resp.data.map(idx => `
        <div class="index-card">
          <div class="index-card-name">${idx.name}</div>
          <div class="index-card-value">${idx.value}</div>
          <div class="index-card-change ${cls(idx.change_percent)}">${idx.change} ${idx.change_percent}</div>
        </div>
      `).join('');
      
      // 更新底部指数栏
      const sh = resp.data[0];
      if (sh) {
        $('indexValue').textContent = sh.value;
        $('indexChange').textContent = sh.change;
        $('indexChange').className = `index-change ${cls(sh.change_percent)}`;
        $('indexPercent').textContent = sh.change_percent;
        $('indexPercent').className = `index-percent ${cls(sh.change_percent)}`;
      }
    }
  };

  const loadDistribution = async () => {
    const container = $('distributionSection');
    if (!container) return;
    
    const resp = await api(`${API}/market`, { action: 'distribution' });
    if (resp.success) {
      const d = resp.data;
      const dist = d.distribution;
      const maxCount = Math.max(
        dist.lt_neg5, dist.neg5_neg3, dist.neg3_neg1, dist.neg1_0,
        dist.zero, dist['0_1'], dist['1_3'], dist['3_5'], dist.gt_5
      ) || 1;
      
      const bars = [
        { label: '≤-5', count: dist.lt_neg5, type: 'fall' },
        { label: '-5~-3', count: dist.neg5_neg3, type: 'fall' },
        { label: '-3~-1', count: dist.neg3_neg1, type: 'fall' },
        { label: '-1~0', count: dist.neg1_0, type: 'fall' },
        { label: '0', count: dist.zero, type: 'fall' },
        { label: '0~1', count: dist['0_1'], type: 'rise' },
        { label: '1~3', count: dist['1_3'], type: 'rise' },
        { label: '3~5', count: dist['3_5'], type: 'rise' },
        { label: '≥5', count: dist.gt_5, type: 'rise' }
      ];
      
      const totalCount = d.up_count + d.down_count;
      const downPct = totalCount > 0 ? (d.down_count / totalCount * 100) : 50;
      
      container.innerHTML = `
        <div class="section-header">
          <span class="section-title">基金涨跌分布</span>
          <span class="section-time">更新: ${d.update_time}</span>
        </div>
        <div class="distribution-chart">
          ${bars.map(b => `
            <div class="distribution-bar">
              <span class="distribution-bar-count">${b.count}</span>
              <div class="distribution-bar-inner ${b.type}" style="height: ${b.count / maxCount * 100}px"></div>
              <span class="distribution-bar-label">${b.label}</span>
            </div>
          `).join('')}
        </div>
        <div class="distribution-summary">
          <div class="distribution-down-bar" style="width: ${downPct}%"></div>
          <div class="distribution-up-bar" style="width: ${100 - downPct}%"></div>
        </div>
        <div class="distribution-labels">
          <span class="distribution-down-label">下跌 ${d.down_count}</span>
          <span class="distribution-up-label">${d.up_count} 上涨</span>
        </div>
      `;
    }
  };

  const loadHotFunds = async () => {
    const container = $('hotFundsSection');
    if (!container) return;
    
    const resp = await api(`${API}/fund`, { action: 'hot' });
    if (resp.success) {
      container.innerHTML = `
        <div class="fund-section-header">
          <span class="fund-section-title">场外基金</span>
          <span class="fund-section-arrow">›</span>
        </div>
        ${resp.data.slice(0, 5).map(f => `
          <div class="fund-section-item" data-code="${f.code}">
            <div class="fund-section-info">
              <div class="fund-section-name">${f.name}</div>
              <div class="fund-section-code">${f.code}</div>
            </div>
            <span class="fund-section-change">-</span>
            <span class="fund-section-change ${cls(f.change)}">${f.change}%</span>
          </div>
        `).join('')}
      `;
      
      container.querySelectorAll('.fund-section-item').forEach(item => {
        item.onclick = () => openFundDetail(item.dataset.code);
      });
    }
  };

  const loadSectorEntry = async () => {
    const container = $('sectorEntrySection');
    if (!container) return;
    
    const resp = await api(`${API}/sector`, { action: 'streak' });
    if (resp.success) {
      const sectors = resp.data.slice(0, 3);
      container.innerHTML = `
        <div class="sector-entry-header" id="sectorEntryHeader">
          <span class="section-title">板块总览</span>
          <span class="sector-entry-arrow">›</span>
        </div>
        ${sectors.map(s => `
          <div class="sector-entry-item">
            <div class="sector-entry-info">
              <div class="sector-entry-name">${s.name}</div>
              <div class="sector-entry-count">${s.funds}只基金</div>
            </div>
            <div class="sector-entry-streak ${s.streak_days >= 0 ? 'rise' : 'fall'}">
              ${s.streak_days >= 0 ? '连涨' : '连跌'} ${Math.abs(s.streak_days)} 天
            </div>
            <div class="sector-entry-change ${cls(s.change_percent)}">${s.change_percent}</div>
          </div>
        `).join('')}
      `;
      
      $('sectorEntryHeader')?.addEventListener('click', openSectorModal);
    }
  };

  // ==========================================
  // 页面渲染 - 资讯
  // ==========================================
  
  const renderNewsPage = () => {
    const page = $('page-news');
    if (!page) return;
    
    page.innerHTML = `
      <div class="empty" style="padding-top: 120px;">
        <div class="empty-icon">📰</div>
        <div class="empty-text">资讯功能开发中...</div>
      </div>
    `;
  };

  // ==========================================
  // 弹层 - 搜索
  // ==========================================
  
  const openSearchModal = () => {
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
  };

  const renderSearchContent = () => {
    const historyList = $('historyList');
    const hotList = $('hotList');
    
    // 渲染历史
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
    
    // 加载热搜
    loadHotSearch();
  };

  const loadHotSearch = async () => {
    const hotList = $('hotList');
    if (!hotList) return;
    
    const resp = await api(`${API}/fund`, { action: 'hot' });
    if (resp.success) {
      hotList.innerHTML = resp.data.slice(0, 5).map((f, i) => `
        <div class="hot-item" data-code="${f.code}">
          <span class="hot-rank">${i + 1}</span>
          <div class="hot-info">
            <div class="hot-name">${f.name}</div>
            <div class="hot-code">${f.code}</div>
          </div>
        </div>
      `).join('');
      
      hotList.querySelectorAll('.hot-item').forEach(item => {
        item.onclick = () => {
          addSearchHistory(item.querySelector('.hot-name').textContent);
          openFundDetail(item.dataset.code);
        };
      });
    }
  };

  const doSearch = debounce(async (keyword) => {
    if (!keyword || keyword.length < 1) {
      $('searchResults').style.display = 'none';
      $('searchHistory').style.display = 'block';
      $('searchHot').style.display = 'block';
      return;
    }
    
    $('searchHistory').style.display = 'none';
    $('searchHot').style.display = 'none';
    
    const results = $('searchResults');
    results.style.display = 'block';
    results.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    const resp = await api(`${API}/fund`, { action: 'search', keyword });
    
    if (resp.success && resp.data.length > 0) {
      results.innerHTML = resp.data.map(f => `
        <div class="result-item" data-code="${f.code}">
          <div class="result-icon">基</div>
          <div class="result-info">
            <div class="result-name">${f.name}</div>
            <div class="result-meta">
              ${f.code}
              ${f.category ? `<span class="result-tag">${f.category}</span>` : ''}
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
          addSearchHistory(item.querySelector('.result-name').textContent);
          openFundDetail(item.dataset.code);
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
    addTargetAccount = accountId;
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
    if (!form) return;
    
    form.innerHTML = addFormItems.map((item, i) => `
      <div class="add-form-item" data-index="${i}">
        ${addFormItems.length > 1 ? `<button class="add-form-close" data-index="${i}">×</button>` : ''}
        <div class="add-form-row">
          <label class="add-form-label">基金名称</label>
          <input type="text" class="add-form-input fund-search-input" 
                 data-index="${i}" 
                 placeholder="请选择基金代码或名称" 
                 value="${item.name || ''}" readonly>
        </div>
        <div class="add-form-row">
          <label class="add-form-label">持有金额</label>
          <input type="number" class="add-form-input amount-input" 
                 data-index="${i}" 
                 placeholder="请输入该基金的持有金额" 
                 value="${item.amount || ''}" inputmode="decimal">
        </div>
        <div class="add-form-row">
          <label class="add-form-label">持有收益</label>
          <input type="number" class="add-form-input profit-input" 
                 data-index="${i}" 
                 placeholder="请输入该基金的持有收益" 
                 value="${item.profit || ''}" inputmode="decimal">
        </div>
        <div class="add-form-toggle">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 15l-6-6-6 6"/>
          </svg>
          收起
        </div>
      </div>
    `).join('');
    
    updateSubmitBtn();
    
    // 绑定事件
    form.querySelectorAll('.add-form-close').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        addFormItems.splice(idx, 1);
        renderAddForm();
      };
    });
    
    form.querySelectorAll('.fund-search-input').forEach(input => {
      input.onclick = () => {
        const idx = parseInt(input.dataset.index);
        openFundPicker(idx);
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

  const openFundPicker = (index) => {
    // 简单实现：直接打开搜索弹层，选中后回填
    openSearchModal();
    
    // 修改搜索结果点击行为
    const originalHandler = (code, name) => {
      addFormItems[index].code = code;
      addFormItems[index].name = name;
      closeSearchModal();
      renderAddForm();
    };
    
    // 临时存储
    window._fundPickerCallback = originalHandler;
  };

  const updateSubmitBtn = () => {
    const validCount = addFormItems.filter(item => 
      item.code && item.amount && parseFloat(item.amount) > 0
    ).length;
    
    const btn = $('submitBtn');
    if (btn) {
      btn.textContent = `完成 (${validCount})`;
      btn.classList.toggle('active', validCount > 0);
    }
  };

  const submitAddForm = () => {
    const validItems = addFormItems.filter(item => 
      item.code && item.amount && parseFloat(item.amount) > 0
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
      } else {
        state.holdings[addTargetAccount].push({
          code: item.code,
          name: item.name,
          amount: parseFloat(item.amount),
          profit: parseFloat(item.profit) || 0
        });
      }
      
      // 同步到自选
      if ($('syncWatch')?.checked) {
        addToWatchlist(item.code, item.name);
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
  
  const openFundDetail = async (code) => {
    const modal = $('detailModal');
    const page = $('detailPage');
    if (!modal || !page) return;
    
    modal.classList.add('active');
    page.innerHTML = '<div class="loading" style="padding-top:100px"><div class="spinner"></div></div>';
    
    const resp = await api(`${API}/fund`, { action: 'detail', code });
    
    if (!resp.success) {
      page.innerHTML = `
        <div class="detail-header">
          <button class="detail-back" id="detailBack">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div class="detail-title-wrap">
            <div class="detail-title">${code}</div>
          </div>
          <div style="width:40px"></div>
        </div>
        <div class="empty" style="padding-top:100px">
          <div class="empty-icon">❌</div>
          <div class="empty-text">${resp.message || '获取失败'}</div>
        </div>
      `;
      $('detailBack').onclick = closeDetailModal;
      return;
    }
    
    const fund = resp.data;
    const isWatched = state.watchlist.some(w => w.code === fund.code);
    
    page.innerHTML = `
      <div class="detail-header">
        <button class="detail-back" id="detailBack">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <button class="detail-nav">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <div class="detail-title-wrap">
          <div class="detail-title">${fund.name || code}</div>
          <div class="detail-code">${fund.code}</div>
        </div>
        <button class="detail-nav">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
        <button class="detail-search">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
        </button>
      </div>
      
      <div class="detail-content">
        <div class="detail-valuation">
          <div class="valuation-row">
            <div>
              <span class="valuation-label">当日涨幅</span>
              <span class="valuation-tag">估</span>
            </div>
            <div class="valuation-year">
              <div class="valuation-year-label">近1年</div>
              <div class="valuation-year-value ${cls(fund.estimate_change)}">+8.29%</div>
            </div>
          </div>
          
          <div class="valuation-chart">日内走势图</div>
          
          <div class="valuation-estimate">
            <span class="estimate-date">日期 ${new Date().toLocaleDateString('zh-CN', {month:'2-digit',day:'2-digit'})}</span>
            <span class="estimate-label">估算涨幅</span>
            <span class="estimate-value ${cls(fund.estimate_change)}">${sign(parseFloat(fund.estimate_change))}${fund.estimate_change}%</span>
          </div>
        </div>
        
        <div class="detail-sector">
          <div class="sector-link">
            <span class="sector-link-name">关联板块：绿色电力</span>
            <span class="sector-link-change rise">+0.33%</span>
          </div>
          <span class="sector-more">10只同类基金 ›</span>
        </div>
        
        <div class="detail-stocks">
          <div class="stocks-header">
            <span class="stocks-title">基金重仓股</span>
            <span class="stocks-more">更多 ›</span>
          </div>
          <div class="stocks-table-header">
            <span class="stocks-col-name">股票名称</span>
            <span class="stocks-col">涨幅</span>
            <span class="stocks-col">持仓占比</span>
            <span class="stocks-col">较上期占比</span>
          </div>
          ${(fund.stocks || []).slice(0, 5).map(s => `
            <div class="stock-item">
              <div class="stock-info">
                <div class="stock-name">${s.name}</div>
                <div class="stock-code">${s.code}</div>
              </div>
              <div class="stock-col ${cls(0)}">+0.35%</div>
              <div class="stock-col">${s.ratio || '--'}</div>
              <div class="stock-col stock-change-up">1.17%↑</div>
            </div>
          `).join('') || '<div class="empty"><div class="empty-text">暂无重仓股数据</div></div>'}
        </div>
      </div>
      
      <div class="detail-actions">
        <button class="detail-action" id="editHoldingBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          修改持仓
        </button>
        <button class="detail-action" id="toggleWatchBtn">
          <svg viewBox="0 0 24 24" fill="${isWatched ? 'var(--primary)' : 'none'}" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
          </svg>
          ${isWatched ? '删自选' : '加自选'}
        </button>
      </div>
    `;
    
    // 绑定事件
    $('detailBack').onclick = closeDetailModal;
    $('toggleWatchBtn').onclick = () => {
      if (isWatched) {
        removeFromWatchlist(fund.code);
      } else {
        addToWatchlist(fund.code, fund.name);
      }
      openFundDetail(code); // 刷新
    };
  };

  const closeDetailModal = () => {
    $('detailModal')?.classList.remove('active');
  };

  // ==========================================
  // 弹层 - 板块总览
  // ==========================================
  
  const openSectorModal = async () => {
    const modal = $('sectorModal');
    const page = $('sectorPage');
    if (!modal || !page) return;
    
    modal.classList.add('active');
    page.innerHTML = `
      <div class="sector-header">
        <button class="back-btn" id="sectorBack">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <h1 class="sector-title">板块总览</h1>
      </div>
      <div class="sector-content">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;
    
    $('sectorBack').onclick = closeSectorModal;
    
    const resp = await api(`${API}/sector`, { action: 'streak' });
    const content = page.querySelector('.sector-content');
    
    if (resp.success) {
      content.innerHTML = `
        <div class="sector-table-header">
          <span class="sector-col-name">板块名称</span>
          <span class="sector-col">涨跌幅 ▼</span>
          <span class="sector-col">连涨天数 ▽</span>
          <span class="sector-col">持有排名 ▽</span>
        </div>
        ${resp.data.map((s, i) => `
          <div class="sector-item">
            <div class="sector-info">
              <div class="sector-name">${s.name}</div>
              <div class="sector-count">${s.funds}只基金</div>
            </div>
            <div class="sector-col-value ${cls(s.change_percent)}">${s.change_percent}</div>
            <div class="sector-col-value ${s.streak_days >= 0 ? 'rise' : 'fall'}">${s.streak_days}天</div>
            <div class="sector-col-value">${i + 1}</div>
          </div>
        `).join('')}
      `;
    }
  };

  const closeSectorModal = () => {
    $('sectorModal')?.classList.remove('active');
  };

  // ==========================================
  // 自选管理
  // ==========================================
  
  const addToWatchlist = (code, name) => {
    if (!code || state.watchlist.some(w => w.code === code)) return;
    state.watchlist.unshift({ code, name });
    saveWatchlist();
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
    
    // 更新Tab状态
    $$('.tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === pageId);
    });
    
    // 更新页面显示
    $$('.page').forEach(page => {
      page.classList.toggle('active', page.dataset.page === pageId);
    });
    
    // 更新Header
    if (pageId === 'hold') {
      renderHoldTabs();
    } else {
      $('headerTabs').innerHTML = '';
    }
    
    // 渲染页面内容
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
    
    // 显示/隐藏指数栏
    $('indexBar').style.display = (pageId === 'hold' || pageId === 'watch') ? 'flex' : 'none';
  };

  // ==========================================
  // 初始化
  // ==========================================
  
  const init = () => {
    // 加载状态
    loadState();
    
    // 绑定TabBar
    $$('.tab').forEach(tab => {
      tab.onclick = () => switchPage(tab.dataset.tab);
    });
    
    // 绑定搜索按钮
    $('searchBtn')?.addEventListener('click', openSearchModal);
    $('searchCancel')?.addEventListener('click', closeSearchModal);
    
    // 绑定搜索输入
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
    
    // 绑定新增弹层
    $('addBack')?.addEventListener('click', closeAddModal);
    $('addMore')?.addEventListener('click', () => {
      addFormItems.push({ code: '', name: '', amount: '', profit: '' });
      renderAddForm();
    });
    $('submitBtn')?.addEventListener('click', submitAddForm);
    
    // 禁止双指缩放
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());
    
    // 注册ServiceWorker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    
    // 初始渲染
    switchPage('hold');
    
    // 加载指数
    loadIndices();
  };

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
