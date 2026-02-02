# -*- coding: utf-8 -*-
"""
基金数据 API - 高性能版本
使用东方财富数据源，支持批量请求和缓存
"""

from http.server import BaseHTTPRequestHandler
import json
import re
import time
from datetime import datetime
from urllib.parse import parse_qs, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import urllib3
urllib3.disable_warnings()

# 全局Session复用
SESSION = requests.Session()
SESSION.headers.update({
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
})

# 内存缓存
CACHE = {}
CACHE_TTL = 30  # 30秒缓存


def get_cache(key):
    """获取缓存"""
    if key in CACHE:
        data, ts = CACHE[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del CACHE[key]
    return None


def set_cache(key, data):
    """设置缓存"""
    CACHE[key] = (data, time.time())
    # 清理过期缓存
    now = time.time()
    expired = [k for k, (_, ts) in CACHE.items() if now - ts > CACHE_TTL * 10]
    for k in expired:
        del CACHE[k]


def search_fund(keyword):
    """搜索基金 - 使用东方财富API"""
    cache_key = f"search:{keyword}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
        params = {
            "m": "1",
            "key": keyword,
            "pageindex": "0",
            "pagesize": "20"
        }
        resp = SESSION.get(url, params=params, timeout=5, verify=False)
        data = resp.json()
        
        results = []
        if data.get("Datas"):
            for item in data["Datas"]:
                results.append({
                    "code": item.get("CODE", ""),
                    "name": item.get("NAME", ""),
                    "type": item.get("FundBaseInfo", {}).get("FTYPE", ""),
                    "pinyin": item.get("PINYIN", ""),
                    "category": item.get("CATEGORYDESC", "")
                })
        
        result = {"success": True, "data": results}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"搜索失败: {str(e)}"}


def get_fund_info(code):
    """获取单只基金信息"""
    cache_key = f"info:{code}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        # 获取基金基本信息和估值
        url = f"https://fundgz.1234567.com.cn/js/{code}.js"
        resp = SESSION.get(url, timeout=5, verify=False)
        
        # 解析jsonp格式
        text = resp.text
        match = re.search(r'jsonpgz\((.*)\)', text)
        if not match:
            return {"success": False, "message": "未找到基金"}
        
        data = json.loads(match.group(1))
        
        result = {
            "success": True,
            "data": {
                "code": data.get("fundcode", code),
                "name": data.get("name", ""),
                "nav": data.get("dwjz", ""),         # 净值
                "nav_date": data.get("jzrq", ""),     # 净值日期
                "estimate_nav": data.get("gsz", ""),  # 估算净值
                "estimate_change": data.get("gszzl", "0"),  # 估算涨跌幅
                "estimate_time": data.get("gztime", ""),    # 估算时间
            }
        }
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取失败: {str(e)}"}


def get_fund_detail(code):
    """获取基金详细信息（包含重仓股）"""
    cache_key = f"detail:{code}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        # 获取基金详情
        url = f"https://fund.eastmoney.com/{code}.html"
        resp = SESSION.get(url, timeout=5, verify=False)
        html = resp.text
        
        # 提取基金名称
        name_match = re.search(r'<span class="funCur-FundName"[^>]*>([^<]+)</span>', html)
        name = name_match.group(1) if name_match else ""
        
        # 获取基金估值
        info = get_fund_info(code)
        
        # 获取重仓股
        stocks = []
        stocks_url = f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10"
        stocks_resp = SESSION.get(stocks_url, timeout=5, verify=False)
        
        # 解析重仓股数据
        stock_pattern = r'<td[^>]*>(\d{6})</td>\s*<td[^>]*><a[^>]*>([^<]+)</a></td>\s*<td[^>]*>([^<]*)</td>\s*<td[^>]*>([^<]*)</td>'
        for match in re.finditer(stock_pattern, stocks_resp.text):
            stocks.append({
                "code": match.group(1),
                "name": match.group(2),
                "ratio": match.group(3),
                "shares": match.group(4)
            })
        
        result = {
            "success": True,
            "data": {
                "code": code,
                "name": name or (info.get("data", {}).get("name", "") if info.get("success") else ""),
                "estimate_change": info.get("data", {}).get("estimate_change", "0") if info.get("success") else "0",
                "estimate_time": info.get("data", {}).get("estimate_time", "") if info.get("success") else "",
                "nav": info.get("data", {}).get("nav", "") if info.get("success") else "",
                "nav_date": info.get("data", {}).get("nav_date", "") if info.get("success") else "",
                "stocks": stocks[:10]
            }
        }
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取详情失败: {str(e)}"}


def batch_get_funds(codes):
    """批量获取基金信息 - 并行请求"""
    results = []
    
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(get_fund_info, code): code for code in codes}
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
    
    # 按原始顺序排序
    code_order = {code: i for i, code in enumerate(codes)}
    results.sort(key=lambda x: code_order.get(x.get("code", ""), 999))
    
    return {"success": True, "data": results}


def get_hot_funds():
    """获取热门基金"""
    cache_key = "hot_funds"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        url = "https://fundmobapi.eastmoney.com/FundMApi/FundRankNewList.ashx"
        params = {
            "fundtype": "0",
            "sorttype": "SYL_D",
            "sort": "desc",
            "pageindex": "0",
            "pagesize": "20",
            "plat": "Iphone",
            "version": "6.5.5"
        }
        resp = SESSION.get(url, params=params, timeout=5, verify=False)
        data = resp.json()
        
        results = []
        if data.get("Datas"):
            for item in data["Datas"]:
                results.append({
                    "code": item.get("FCODE", ""),
                    "name": item.get("SHORTNAME", ""),
                    "change": item.get("SYL_D", "0"),
                    "type": item.get("FTYPE", "")
                })
        
        result = {"success": True, "data": results}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取热门失败: {str(e)}"}


class handler(BaseHTTPRequestHandler):
    def _send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'public, max-age=30, s-maxage=60')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def do_OPTIONS(self):
        self._send_json({})
    
    def do_GET(self):
        start_time = time.time()
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        action = params.get('action', [''])[0]
        
        result = {"success": False, "message": "未知操作"}
        
        try:
            if action == 'search':
                keyword = params.get('keyword', params.get('code', ['']))[0]
                if keyword:
                    result = search_fund(keyword)
                else:
                    result = {"success": False, "message": "请输入搜索关键词"}
            
            elif action == 'info':
                code = params.get('code', [''])[0]
                if code and len(code) == 6:
                    result = get_fund_info(code)
                else:
                    result = {"success": False, "message": "请输入6位基金代码"}
            
            elif action == 'detail':
                code = params.get('code', [''])[0]
                if code and len(code) == 6:
                    result = get_fund_detail(code)
                else:
                    result = {"success": False, "message": "请输入6位基金代码"}
            
            elif action == 'batch':
                codes_str = params.get('codes', [''])[0]
                if codes_str:
                    codes = [c.strip() for c in codes_str.split(',') if c.strip() and len(c.strip()) == 6]
                    if codes:
                        result = batch_get_funds(codes)
                    else:
                        result = {"success": False, "message": "无有效基金代码"}
                else:
                    result = {"success": False, "message": "请提供基金代码列表"}
            
            elif action == 'hot':
                result = get_hot_funds()
            
            else:
                result = {"success": False, "message": f"未知操作: {action}"}
        
        except Exception as e:
            result = {"success": False, "message": str(e)}
        
        # 添加响应时间
        result["_ms"] = round((time.time() - start_time) * 1000)
        self._send_json(result)
    
    def do_POST(self):
        self.do_GET()
