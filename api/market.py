# -*- coding: utf-8 -*-
"""
市场数据 API - 高性能版本
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
CACHE_TTL = 10  # 10秒缓存（行情数据更新频繁）


def get_cache(key):
    if key in CACHE:
        data, ts = CACHE[key]
        if time.time() - ts < CACHE_TTL:
            return data
        del CACHE[key]
    return None


def set_cache(key, data):
    CACHE[key] = (data, time.time())


def get_indices():
    """获取主要指数"""
    cache_key = "indices"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    try:
        # 使用新浪财经接口
        codes = "s_sh000001,s_sz399001,s_sz399006,s_sh000300"
        url = f"https://hq.sinajs.cn/list={codes}"
        resp = SESSION.get(url, timeout=5, verify=False)
        
        indices = []
        lines = resp.text.strip().split('\n')
        names = ["上证指数", "深证成指", "创业板指", "沪深300"]
        
        for i, line in enumerate(lines):
            if '="' not in line:
                continue
            data = line.split('="')[1].rstrip('";').split(',')
            if len(data) >= 4:
                indices.append({
                    "name": names[i] if i < len(names) else data[0],
                    "value": data[1],
                    "change": data[2],
                    "change_percent": f"{data[3]}%"
                })
        
        result = {"success": True, "data": indices}
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取指数失败: {str(e)}"}


def get_fund_distribution():
    """获取基金涨跌分布"""
    cache_key = "distribution"
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
            "pagesize": "10000",
            "plat": "Iphone"
        }
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = resp.json()
        
        # 统计涨跌分布
        distribution = {
            "lt_neg5": 0,    # <-5%
            "neg5_neg3": 0,  # -5%~-3%
            "neg3_neg1": 0,  # -3%~-1%
            "neg1_0": 0,     # -1%~0%
            "zero": 0,       # 0%
            "0_1": 0,        # 0%~1%
            "1_3": 0,        # 1%~3%
            "3_5": 0,        # 3%~5%
            "gt_5": 0        # >5%
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
        set_cache(cache_key, result)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取分布失败: {str(e)}"}


class handler(BaseHTTPRequestHandler):
    def _send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'public, max-age=10, s-maxage=30')
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
            if action == 'indices':
                result = get_indices()
            elif action == 'distribution':
                result = get_fund_distribution()
            else:
                result = {"success": False, "message": f"未知操作: {action}"}
        except Exception as e:
            result = {"success": False, "message": str(e)}
        
        result["_ms"] = round((time.time() - start_time) * 1000)
        self._send_json(result)
    
    def do_POST(self):
        self.do_GET()
