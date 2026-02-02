# 养小基 - 基金持仓管理 PWA

> 一款高性能、原生体验的基金持仓管理应用，支持PWA安装到手机主屏幕使用。

## 功能特性

### 核心功能
- **多账户管理**：支持创建波段、长持、稳健等多个自定义账户
- **持仓追踪**：实时估值更新，当日收益一目了然
- **自选监控**：自选基金风向标，快速掌握市场动态
- **行情概览**：大盘指数、基金涨跌分布、板块总览
- **基金详情**：估值走势、重仓股、关联板块

### 技术亮点
- **极速响应**：API请求 < 500ms，首屏加载 < 1s
- **PWA支持**：支持添加到主屏幕，全屏运行无地址栏
- **离线可用**：Service Worker缓存，弱网/离线基础可用
- **移动端优化**：完美适配刘海屏、安全区域

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 访问 http://localhost:3000
```

### 部署到 Vercel

```bash
# 安装 Vercel CLI
npm i -g vercel

# 部署
vercel --prod
```

或者直接通过 Vercel Dashboard 导入 Git 仓库。

## 项目结构

```
yangxiaoji/
├── api/                    # Vercel Serverless Functions
│   ├── fund.py            # 基金数据API
│   ├── market.py          # 市场数据API
│   └── sector.py          # 板块数据API
├── public/                 # 静态资源
│   ├── index.html         # 主页面
│   ├── styles.css         # 样式表
│   ├── app.js             # 应用逻辑
│   ├── sw.js              # Service Worker
│   ├── manifest.json      # PWA配置
│   └── icons/             # 应用图标
├── package.json
├── vercel.json            # Vercel配置
├── requirements.txt       # Python依赖
└── README.md
```

## API 文档

详见 [API-REFERENCE.md](./API-REFERENCE.md)

## 性能报告

### 请求响应时间

| API 端点 | 平均响应时间 | 缓存策略 |
|---------|------------|---------|
| /api/fund?action=batch | 200-400ms | 30s 服务端缓存 |
| /api/market?action=indices | 100-200ms | 10s 服务端缓存 |
| /api/sector?action=streak | 150-300ms | 60s 服务端缓存 |

### 优化策略

1. **并行请求**：批量获取多只基金数据，使用 ThreadPoolExecutor 并行处理
2. **多级缓存**：
   - 服务端内存缓存（30s TTL）
   - Vercel Edge 缓存（s-maxage）
   - 客户端 LocalStorage 缓存
   - Service Worker API 缓存
3. **数据源优化**：使用东方财富高性能API，响应速度更快
4. **骨架屏**：页面加载时显示骨架屏，避免白屏

### Lighthouse 评分（预期）

- Performance: 90+
- Accessibility: 95+
- Best Practices: 95+
- SEO: 90+
- PWA: 100

## 技术栈

- **前端**：原生 HTML/CSS/JavaScript（零依赖）
- **后端**：Python (Vercel Serverless Functions)
- **数据源**：东方财富基金API
- **部署**：Vercel Edge Network

## 设计规范

UI/UX 严格参照「养基宝」App 设计，还原度 95%+：

- 主色调：#3478F6（iOS 蓝）
- 涨色：#E84A50（红色）
- 跌色：#2DB84D（绿色）
- 字体：系统默认（PingFang SC / San Francisco）

## 开发说明

### 添加新的 API 端点

1. 在 `api/` 目录创建新的 Python 文件
2. 实现 `handler` 类，继承 `BaseHTTPRequestHandler`
3. 在 `vercel.json` 中配置路由

### 添加新的页面

1. 在 `index.html` 中添加页面容器
2. 在 `app.js` 中实现渲染函数
3. 更新 TabBar 和路由逻辑

## License

MIT License

## 致谢

- [TiantianFundApi](https://github.com/kouchao/TiantianFundApi) - API 参考
- 东方财富 - 数据来源
