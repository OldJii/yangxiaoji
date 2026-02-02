/**
 * 养小基 - Service Worker
 * 实现离线缓存和性能优化
 */

const CACHE_VERSION = 'yangxiaoji-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

// 静态资源列表
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png'
];

// API缓存时间（秒）
const API_CACHE_TTL = {
  '/api/index': 30
};

// 安装事件 - 预缓存静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== STATIC_CACHE && key !== API_CACHE)
            .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// 请求拦截
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // API请求 - 网络优先，带缓存回退
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/market' ||
    url.pathname === '/fund' ||
    url.pathname === '/sector' ||
    url.pathname === '/news'
  ) {
    event.respondWith(handleApiRequest(event.request));
    return;
  }
  
  // 静态资源 - 缓存优先
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          // 后台更新缓存
          fetch(event.request)
            .then(response => {
              if (response.ok) {
                caches.open(STATIC_CACHE)
                  .then(cache => cache.put(event.request, response));
              }
            })
            .catch(() => {});
          return cached;
        }
        return fetch(event.request)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(STATIC_CACHE)
                .then(cache => cache.put(event.request, clone));
            }
            return response;
          });
      })
  );
});

// 处理API请求
async function handleApiRequest(request) {
  const url = new URL(request.url);
  const cacheKey = url.pathname + url.search;
  
  try {
    // 尝试网络请求
    const response = await fetch(request, { 
      signal: AbortSignal.timeout(8000) 
    });
    
    if (response.ok) {
      // 缓存响应
      const cache = await caches.open(API_CACHE);
      const clonedResponse = response.clone();
      
      // 添加时间戳头
      const headers = new Headers(clonedResponse.headers);
      headers.set('sw-cached-at', Date.now().toString());
      
      const cachedResponse = new Response(await clonedResponse.blob(), {
        status: clonedResponse.status,
        statusText: clonedResponse.statusText,
        headers
      });
      
      cache.put(cacheKey, cachedResponse);
    }
    
    return response;
  } catch (error) {
    // 网络失败，尝试缓存
    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(cacheKey);
    
    if (cached) {
      // 检查缓存是否过期
      const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
      const ttl = getApiTTL(url.pathname) * 1000;
      
      if (Date.now() - cachedAt < ttl * 10) { // 离线时允许10倍TTL
        return cached;
      }
    }
    
    // 返回离线响应
    return new Response(JSON.stringify({
      success: false,
      message: '网络不可用，请稍后重试',
      offline: true
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 获取API缓存时间
function getApiTTL(pathname) {
  for (const [prefix, ttl] of Object.entries(API_CACHE_TTL)) {
    if (pathname.startsWith(prefix)) {
      return ttl;
    }
  }
  return 30; // 默认30秒
}

// 后台同步
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  // 预加载常用数据
  const urls = [
    '/api/index?module=market&action=indices',
    '/api/index?module=sector&action=streak'
  ];
  
  await Promise.all(urls.map(url => 
    fetch(url).catch(() => {})
  ));
}

// 消息处理
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
