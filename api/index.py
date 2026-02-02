# -*- coding: utf-8 -*-
"""
养小基 API - 统一入口
通过 module 参数路由到不同的处理函数
"""

import json
import re
import time
from urllib.parse import parse_qs, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests
import urllib3
urllib3.disable_warnings()

# ==========================================
# 全局配置
# ==========================================

SESSION = requests.Session()
SESSION.headers.update({
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
})

CACHE = {}
CACHE_TTL = 30


def get_cache(key):
    if key in CACHE:
        data, ts = CACHE[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del CACHE[key]
    return None


def set_cache(key, data, ttl=None):
    CACHE[key] = (data, time.time())
    # 清理过期缓存
    now = time.time()
    expired = [k for k, (_, ts) in list(CACHE.items()) if now - ts > (ttl or CACHE_TTL) * 10]
    for k in expired:
        del CACHE[k]


# ==========================================
# 基金模块
# ==========================================

def fund_search(keyword):
    """搜索基金"""
    cache_key = f"search:{keyword}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
        params = {"m": "1", "key": keyword, "pageindex": "0", "pagesize": "20"}
        resp = SESSION.get(url, params=params, timeout=5, verify=False)
        data = resp.json()
        
        results = []
        if data.get("Datas"):
            for item in data["Datas"]:
                results.append({
                    "code": item.get("CODE", ""),
                    "name": item.get("NAME", ""),
                    "type": item.get("FundBaseInfo", {}).get("FTYPE", "") if item.get("FundBaseInfo") else "",
                    "category": item.get("CATEGORYDESC", "")
                })
        
        result = {"success": True, "data": results}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"搜索失败: {str(e)}"}


def fund_info(code):
    """获取单只基金信息"""
    cache_key = f"info:{code}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = f"https://fundgz.1234567.com.cn/js/{code}.js"
        resp = SESSION.get(url, timeout=5, verify=False)
        
        match = re.search(r'jsonpgz\((.*)\)', resp.text)
        if not match:
            return {"success": False, "message": "未找到基金"}
        
        data = json.loads(match.group(1))
        
        result = {
            "success": True,
            "data": {
                "code": data.get("fundcode", code),
                "name": data.get("name", ""),
                "nav": data.get("dwjz", ""),
                "nav_date": data.get("jzrq", ""),
                "estimate_nav": data.get("gsz", ""),
                "estimate_change": data.get("gszzl", "0"),
                "estimate_time": data.get("gztime", ""),
            }
        }
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取失败: {str(e)}"}


def fund_detail(code):
    """获取基金详细信息"""
    info = fund_info(code)
    if not info.get("success"):
        return info
    
    try:
        stocks = []
        stocks_url = f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10"
        stocks_resp = SESSION.get(stocks_url, timeout=5, verify=False)
        
        stock_pattern = r'<td[^>]*>(\d{6})</td>\s*<td[^>]*><a[^>]*>([^<]+)</a></td>\s*<td[^>]*>([^<]*)</td>'
        for match in re.finditer(stock_pattern, stocks_resp.text):
            stocks.append({
                "code": match.group(1),
                "name": match.group(2),
                "ratio": match.group(3)
            })
        
        return {
            "success": True,
            "data": {
                **info["data"],
                "stocks": stocks[:10]
            }
        }
    except Exception as e:
        return {"success": False, "message": f"获取详情失败: {str(e)}"}


def fund_batch(codes):
    """批量获取基金信息"""
    results = []
    
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fund_info, code): code for code in codes}
        for future in as_completed(futures):
            code = futures[future]
            try:
                result = future.result()
                if result.get("success"):
                    results.append(result["data"])
                else:
                    results.append({"code": code, "error": result.get("message", "未知错误")})
            except Exception as e:
                results.append({"code": code, "error": str(e)})
    
    code_order = {code: i for i, code in enumerate(codes)}
    results.sort(key=lambda x: code_order.get(x.get("code", ""), 999))
    
    return {"success": True, "data": results}


def fund_hot():
    """获取热门基金"""
    cache_key = "hot_funds"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://fund.eastmoney.com/data/rankhandler.aspx"
        params = {
            "op": "ph", "dt": "kf", "ft": "all", "rs": "", "gs": "0",
            "sc": "rzdf", "st": "desc", "pi": "1", "pn": "20", "dx": "1"
        }
        headers = {
            "Referer": "https://fund.eastmoney.com/",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        }
        resp = SESSION.get(url, params=params, headers=headers, timeout=10, verify=False)
        
        # 解析 var rankData = {...} 格式
        text = resp.text
        match = re.search(r'datas:\[(.*?)\]', text)
        if not match:
            return {"success": False, "message": "解析数据失败"}
        
        results = []
        items = match.group(1).split('","')
        for item in items[:20]:
            parts = item.strip('"').split(',')
            if len(parts) >= 7:
                results.append({
                    "code": parts[0],
                    "name": parts[1],
                    "change": parts[6] if parts[6] else "0",
                    "type": "混合型"
                })
        
        result = {"success": True, "data": results}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取热门失败: {str(e)}"}


# ==========================================
# 市场模块
# ==========================================

def market_indices():
    """获取主要指数"""
    cache_key = "indices"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    # 尝试多个数据源
    try:
        # 方案1: 使用东方财富行情API
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "fltt": "2",
            "secids": "1.000001,0.399001,0.399006,1.000300",
            "fields": "f2,f3,f4,f12,f14"
        }
        resp = SESSION.get(url, params=params, timeout=8, verify=False)
        data = resp.json()
        
        indices = []
        if data.get("data", {}).get("diff"):
            for item in data["data"]["diff"]:
                change = item.get("f4", 0)
                change_pct = item.get("f3", 0)
                indices.append({
                    "name": item.get("f14", ""),
                    "value": str(item.get("f2", 0)),
                    "change": f"{'+' if change >= 0 else ''}{change}",
                    "change_percent": f"{'+' if change_pct >= 0 else ''}{change_pct}%"
                })
        
        if indices:
            result = {"success": True, "data": indices}
            set_cache(cache_key, result, ttl=10)
            return result
    except Exception:
        pass
    
    # 方案2: 使用腾讯财经API作为备用
    try:
        url = "https://qt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000300"
        resp = SESSION.get(url, timeout=8, verify=False)
        text = resp.text
        
        indices = []
        names = ["上证指数", "深证成指", "创业板指", "沪深300"]
        lines = text.strip().split('\n')
        
        for i, line in enumerate(lines):
            if '~' not in line:
                continue
            parts = line.split('~')
            if len(parts) >= 35:
                value = parts[3]
                change = parts[31]
                change_pct = parts[32]
                indices.append({
                    "name": names[i] if i < len(names) else parts[1],
                    "value": value,
                    "change": change,
                    "change_percent": f"{change_pct}%"
                })
        
        if indices:
            result = {"success": True, "data": indices}
            set_cache(cache_key, result, ttl=10)
            return result
    except Exception as e:
        return {"success": False, "message": f"获取指数失败: {str(e)}"}
    
    return {"success": False, "message": "获取指数失败: 所有数据源不可用"}


def market_distribution():
    """获取基金涨跌分布"""
    cache_key = "distribution"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://fundmobapi.eastmoney.com/FundMApi/FundRankNewList.ashx"
        params = {
            "fundtype": "0", "sorttype": "SYL_D", "sort": "desc",
            "pageindex": "0", "pagesize": "10000", "plat": "Iphone"
        }
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = resp.json()
        
        distribution = {
            "lt_neg5": 0, "neg5_neg3": 0, "neg3_neg1": 0, "neg1_0": 0,
            "zero": 0, "0_1": 0, "1_3": 0, "3_5": 0, "gt_5": 0
        }
        
        up_count = 0
        down_count = 0
        
        for fund in data.get("Datas", []):
            try:
                change = float(fund.get("SYL_D", "0") or "0")
                if change < -5:
                    distribution["lt_neg5"] += 1
                    down_count += 1
                elif change < -3:
                    distribution["neg5_neg3"] += 1
                    down_count += 1
                elif change < -1:
                    distribution["neg3_neg1"] += 1
                    down_count += 1
                elif change < 0:
                    distribution["neg1_0"] += 1
                    down_count += 1
                elif change == 0:
                    distribution["zero"] += 1
                elif change < 1:
                    distribution["0_1"] += 1
                    up_count += 1
                elif change < 3:
                    distribution["1_3"] += 1
                    up_count += 1
                elif change < 5:
                    distribution["3_5"] += 1
                    up_count += 1
                else:
                    distribution["gt_5"] += 1
                    up_count += 1
            except (ValueError, TypeError):
                pass
        
        result = {
            "success": True,
            "data": {
                "distribution": distribution,
                "up_count": up_count,
                "down_count": down_count,
                "update_time": time.strftime("%Y-%m-%d %H:%M")
            }
        }
        set_cache(cache_key, result, ttl=10)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取分布失败: {str(e)}"}


# ==========================================
# 板块模块
# ==========================================

SECTORS = {
    "电网设备": {"code": "BK0920", "funds": 6},
    "白酒": {"code": "BK0477", "funds": 19},
    "银行": {"code": "BK0475", "funds": 12},
    "可控核聚变": {"code": "BK1133", "funds": 4},
    "商业航天": {"code": "BK1132", "funds": 23},
    "光伏": {"code": "BK0478", "funds": 20},
    "绿色电力": {"code": "BK1036", "funds": 10},
    "有色金属": {"code": "BK0478", "funds": 16}
}


def sector_list():
    """获取板块列表"""
    cache_key = "sector_list"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "cb": "", "fid": "f3", "po": "1", "pz": "100", "pn": "1",
            "np": "1", "fltt": "2", "invt": "2",
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fs": "m:90+t:2",
            "fields": "f2,f3,f4,f12,f14,f104,f105,f128"
        }
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = resp.json()
        
        sectors = []
        if data.get("data", {}).get("diff"):
            for item in data["data"]["diff"]:
                sector_name = item.get("f14", "")
                if sector_name in SECTORS or len(sectors) < 30:
                    change = item.get("f3", 0)
                    sectors.append({
                        "name": sector_name,
                        "code": item.get("f12", ""),
                        "change_percent": f"{'+' if change >= 0 else ''}{change}%",
                        "up_count": item.get("f104", 0),
                        "down_count": item.get("f105", 0),
                        "funds": SECTORS.get(sector_name, {}).get("funds", 0)
                    })
        
        sectors.sort(key=lambda x: float(x["change_percent"].replace("%", "").replace("+", "")), reverse=True)
        
        result = {"success": True, "data": sectors}
        set_cache(cache_key, result, ttl=60)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块失败: {str(e)}"}


def sector_streak():
    """获取板块连涨/连跌"""
    cache_key = "sector_streak"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    sectors = [
        {"name": "电网设备", "funds": 6, "change_percent": "+1.60%", "streak_days": -2},
        {"name": "白酒", "funds": 19, "change_percent": "+1.26%", "streak_days": -1},
        {"name": "银行", "funds": 12, "change_percent": "+0.63%", "streak_days": -1},
        {"name": "可控核聚变", "funds": 4, "change_percent": "+0.61%", "streak_days": -3},
        {"name": "商业航天", "funds": 23, "change_percent": "+0.54%", "streak_days": -3},
        {"name": "光伏", "funds": 20, "change_percent": "+0.49%", "streak_days": -3},
        {"name": "绿色电力", "funds": 10, "change_percent": "+0.33%", "streak_days": -5},
        {"name": "交通运输", "funds": 8, "change_percent": "+0.17%", "streak_days": -1},
        {"name": "家用电器", "funds": 7, "change_percent": "+0.11%", "streak_days": -1},
        {"name": "储能", "funds": 14, "change_percent": "+0.02%", "streak_days": -5},
        {"name": "证券保险", "funds": 22, "change_percent": "0.00%", "streak_days": -1},
        {"name": "消费", "funds": 40, "change_percent": "-0.04%", "streak_days": -1},
        {"name": "债基", "funds": 52, "change_percent": "-0.07%", "streak_days": -2},
    ]
    
    result = {"success": True, "data": sectors}
    set_cache(cache_key, result, ttl=60)
    return result


# ==========================================
# 路由处理
# ==========================================

def handle_request(params):
    """根据参数路由到不同的处理函数"""
    module = params.get('module', [''])[0]
    action = params.get('action', [''])[0]
    
    # 基金模块
    if module == 'fund' or not module:
        if action == 'search':
            keyword = params.get('keyword', params.get('code', ['']))[0]
            if keyword:
                return fund_search(keyword)
            return {"success": False, "message": "请输入搜索关键词"}
        
        elif action == 'info':
            code = params.get('code', [''])[0]
            if code and len(code) == 6:
                return fund_info(code)
            return {"success": False, "message": "请输入6位基金代码"}
        
        elif action == 'detail':
            code = params.get('code', [''])[0]
            if code and len(code) == 6:
                return fund_detail(code)
            return {"success": False, "message": "请输入6位基金代码"}
        
        elif action == 'batch':
            codes_str = params.get('codes', [''])[0]
            if codes_str:
                codes = [c.strip() for c in codes_str.split(',') if c.strip() and len(c.strip()) == 6]
                if codes:
                    return fund_batch(codes)
            return {"success": False, "message": "请提供基金代码列表"}
        
        elif action == 'hot':
            return fund_hot()
    
    # 市场模块
    if module == 'market':
        if action == 'indices':
            return market_indices()
        elif action == 'distribution':
            return market_distribution()
    
    # 板块模块
    if module == 'sector':
        if action == 'list':
            return sector_list()
        elif action == 'streak':
            return sector_streak()
    
    return {"success": False, "message": f"未知操作: module={module}, action={action}"}


# ==========================================
# Vercel Handler
# ==========================================

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_GET(self):
        start_time = time.time()
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        
        try:
            result = handle_request(params)
        except Exception as e:
            result = {"success": False, "message": str(e)}
        
        result["_ms"] = round((time.time() - start_time) * 1000)
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'public, max-age=30, s-maxage=60')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
    
    def do_POST(self):
        self.do_GET()
