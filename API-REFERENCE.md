# 养小基 API 参考手册

## 基础信息

- **Base URL**: `/api`
- **响应格式**: JSON
- **字符编码**: UTF-8

## 通用响应结构

```json
{
  "success": true,
  "data": { ... },
  "_ms": 123  // 响应时间（毫秒）
}
```

错误响应：

```json
{
  "success": false,
  "message": "错误信息",
  "_ms": 50
}
```

---

## 基金 API (`/api/fund`)

### 1. 搜索基金

**请求**
```
GET /api/fund?action=search&keyword=白酒
```

**参数**
| 参数 | 必填 | 说明 |
|------|-----|------|
| keyword | 是 | 搜索关键词（代码/名称/拼音） |

**响应**
```json
{
  "success": true,
  "data": [
    {
      "code": "161725",
      "name": "招商中证白酒指数",
      "type": "指数型",
      "pinyin": "ZSZZBJZS",
      "category": "白酒"
    }
  ]
}
```

### 2. 获取基金信息

**请求**
```
GET /api/fund?action=info&code=161725
```

**参数**
| 参数 | 必填 | 说明 |
|------|-----|------|
| code | 是 | 6位基金代码 |

**响应**
```json
{
  "success": true,
  "data": {
    "code": "161725",
    "name": "招商中证白酒指数",
    "nav": "1.2345",
    "nav_date": "2026-02-01",
    "estimate_nav": "1.2400",
    "estimate_change": "0.45",
    "estimate_time": "11:30:00"
  }
}
```

### 3. 批量获取基金

**请求**
```
GET /api/fund?action=batch&codes=161725,000001,000002
```

**参数**
| 参数 | 必填 | 说明 |
|------|-----|------|
| codes | 是 | 逗号分隔的基金代码 |

**响应**
```json
{
  "success": true,
  "data": [
    {
      "code": "161725",
      "name": "招商中证白酒指数",
      "estimate_change": "0.45",
      "estimate_time": "11:30:00"
    }
  ]
}
```

### 4. 获取基金详情

**请求**
```
GET /api/fund?action=detail&code=161725
```

**响应**
```json
{
  "success": true,
  "data": {
    "code": "161725",
    "name": "招商中证白酒指数",
    "estimate_change": "0.45",
    "estimate_time": "11:30:00",
    "nav": "1.2345",
    "nav_date": "2026-02-01",
    "perf_cmp": "中证白酒指数收益率*90%+上证国债指数收益率*10%",
    "inv_tgt": "通过精选白酒产业链优质标的，在控制风险的前提下力争实现长期稳健增值。",
    "stocks": [
      {
        "code": "600519",
        "name": "贵州茅台",
        "ratio": "15.23%",
        "shares": "123456"
      }
    ]
  }
}
```

### 5. 获取热门基金

**请求**
```
GET /api/fund?action=hot
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "code": "161725",
      "name": "招商中证白酒指数",
      "change": "2.34",
      "type": "指数型"
    }
  ]
}
```

---

## 板块 API (`/api/sector`)

### 1. 获取板块列表

**请求**
```
GET /api/sector?action=list
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "name": "电网设备",
      "code": "BK0920",
      "change_percent": "+1.60%",
      "up_count": 45,
      "down_count": 12,
      "funds": 6
    }
  ]
}
```

### 2. 获取板块连涨/连跌

**请求**
```
GET /api/sector?action=streak
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "name": "电网设备",
      "funds": 6,
      "change_percent": "+1.60%",
      "streak_days": -2
    },
    {
      "name": "白酒",
      "funds": 19,
      "change_percent": "+1.26%",
      "streak_days": -1
    }
  ]
}
```

### 3. 获取板块详情

**请求**
```
GET /api/sector?action=detail&name=电网设备
```

**响应**
```json
{
  "success": true,
  "data": {
    "name": "电网设备",
    "stocks": [
      {
        "code": "600089",
        "name": "特变电工",
        "price": 12.34,
        "change_percent": "+2.34%"
      }
    ]
  }
}
```

---

## 缓存策略

| 端点 | 服务端缓存 | Edge缓存 | 客户端缓存 |
|------|----------|---------|-----------|
| /api/fund | 30s | 60s | 30s |
| /api/sector | 60s | 60s | 60s |

## 性能优化说明

1. **批量接口优先**：使用 `action=batch` 一次获取多只基金，避免多次请求
2. **并行处理**：服务端使用线程池并行获取数据
3. **Edge缓存**：Vercel Edge Network 全球加速
4. **客户端缓存**：LocalStorage + Service Worker 双重缓存

## 错误码

| 状态码 | 说明 |
|-------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 500 | 服务器内部错误 |
| 503 | 上游服务不可用 |
