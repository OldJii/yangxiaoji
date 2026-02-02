# -*- coding: utf-8 -*-
"""
板块数据 API - 高性能版本
"""

from http.server import BaseHTTPRequestHandler
import json
import time
from urllib.parse import parse_qs, urlparse

import requests
import urllib3
urllib3.disable_warnings()

SESSION = requests.Session()
SESSION.headers.update({
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
})

CACHE = {}
CACHE_TTL = 60  # 60秒缓存

# 板块配置
SECTORS = {
    "电网设备": {"code": "BK0920", "funds": 6},
    "白酒": {"code": "BK0477", "funds": 19},
    "银行": {"code": "BK0475", "funds": 12},
    "可控核聚变": {"code": "BK1133", "funds": 4},
    "商业航天": {"code": "BK1132", "funds": 23},
    "光伏": {"code": "BK0478", "funds": 20},
    "绿色电力": {"code": "BK1036", "funds": 10},
    "交通运输": {"code": "BK0422", "funds": 8},
    "家用电器": {"code": "BK0428", "funds": 7},
    "储能": {"code": "BK0728", "funds": 14},
    "证券保险": {"code": "BK0474", "funds": 22},
    "消费": {"code": "BK0438", "funds": 40},
    "债基": {"code": "BK0473", "funds": 52},
    "金融科技": {"code": "BK0800", "funds": 15},
    "人工智能": {"code": "BK0800", "funds": 25},
    "半导体": {"code": "BK0447", "funds": 18},
    "医药": {"code": "BK0465", "funds": 35},
    "有色金属": {"code": "BK0478", "funds": 16}
}


def get_cache(key):
    if key in CACHE:
        data, ts = CACHE[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del CACHE[key]
    return None


def set_cache(key, data):
    CACHE[key] = (data, time.time())


def get_sector_list():
    """获取板块列表及涨跌幅"""
    cache_key = "sector_list"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        # 获取东方财富板块行情
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "cb": "",
            "fid": "f3",
            "po": "1",
            "pz": "100",
            "pn": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
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
                    up_count = item.get("f104", 0)
                    down_count = item.get("f105", 0)
                    
                    sectors.append({
                        "name": sector_name,
                        "code": item.get("f12", ""),
                        "change_percent": f"{'+' if change >= 0 else ''}{change}%",
                        "up_count": up_count,
                        "down_count": down_count,
                        "funds": SECTORS.get(sector_name, {}).get("funds", 0)
                    })
        
        # 按涨跌幅排序
        sectors.sort(key=lambda x: float(x["change_percent"].replace("%", "").replace("+", "")), reverse=True)
        
        result = {"success": True, "data": sectors}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块失败: {str(e)}"}


def get_sector_detail(sector_name):
    """获取板块详情"""
    cache_key = f"sector_detail:{sector_name}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    sector_config = SECTORS.get(sector_name)
    if not sector_config:
        return {"success": False, "message": "未找到板块"}
    
    try:
        # 获取板块成分股
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "cb": "",
            "fid": "f3",
            "po": "1",
            "pz": "50",
            "pn": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fs": f"b:{sector_config['code']}",
            "fields": "f2,f3,f4,f12,f14"
        }
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = resp.json()
        
        stocks = []
        if data.get("data", {}).get("diff"):
            for item in data["data"]["diff"]:
                change = item.get("f3", 0)
                stocks.append({
                    "code": item.get("f12", ""),
                    "name": item.get("f14", ""),
                    "price": item.get("f2", 0),
                    "change_percent": f"{'+' if change >= 0 else ''}{change}%"
                })
        
        result = {
            "success": True,
            "data": {
                "name": sector_name,
                "stocks": stocks
            }
        }
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块详情失败: {str(e)}"}


def get_sector_streak():
    """获取板块连涨/连跌天数"""
    cache_key = "sector_streak"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    # 模拟连涨/连跌数据（实际需要历史数据计算）
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
    set_cache(cache_key, result)
    return result


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
            if action == 'list':
                result = get_sector_list()
            elif action == 'streak':
                result = get_sector_streak()
            elif action == 'detail':
                name = params.get('name', [''])[0]
                if name:
                    result = get_sector_detail(name)
                else:
                    result = {"success": False, "message": "请提供板块名称"}
            else:
                result = {"success": False, "message": f"未知操作: {action}"}
        except Exception as e:
            result = {"success": False, "message": str(e)}
        
        result["_ms"] = round((time.time() - start_time) * 1000)
        self._send_json(result)
    
    def do_POST(self):
        self.do_GET()
