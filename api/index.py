# -*- coding: utf-8 -*-
"""
养小基 API - 统一入口
完整的基金、板块、市场和资讯数据
"""

import json
import os
import re
import time
import random
from urllib.parse import parse_qs, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests
from requests.adapters import HTTPAdapter
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
SESSION.mount("https://", HTTPAdapter(pool_connections=20, pool_maxsize=20))
SESSION.mount("http://", HTTPAdapter(pool_connections=20, pool_maxsize=20))

CACHE = {}
CACHE_TTL = 60  # 默认缓存60秒
 # 热门/板块等弱实时数据使用更长缓存，降低上游压力
FUND_HOT_TTL = 10 * 60
FUND_DETAIL_PART_TTL = 6 * 60 * 60
SECTOR_STREAK_TTL = 10 * 60
SECTOR_STREAK_ITEM_TTL = 30 * 60
SECTOR_FUNDS_TTL = 15 * 60
EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b"
TIANTIAN_API_BASE = os.getenv(
    "TIANTIAN_API_BASE",
    "https://tiantian-fund-api.vercel.app/api/action"
)


def get_cache(key, ttl=None):
    if key in CACHE:
        data, ts = CACHE[key]
        if time.time() - ts < (ttl or CACHE_TTL):
            return data
        del CACHE[key]
    return None


def set_cache(key, data, ttl=None):
    CACHE[key] = (data, time.time())
    # 清理过期缓存
    now = time.time()
    expired = [k for k, (_, ts) in list(CACHE.items()) if now - ts > CACHE_TTL * 5]
    for k in expired[:10]:  # 每次最多清理10个
        CACHE.pop(k, None)


def _safe_json(resp):
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError):
        return None


def _tiantian_action(action_name, params=None, timeout=8):
    request_params = {"action_name": action_name}
    if params:
        request_params.update(params)
    try:
        resp = SESSION.get(
            TIANTIAN_API_BASE,
            params=request_params,
            timeout=timeout,
            verify=False
        )
    except requests.RequestException as e:
        return None, str(e)
    data = _safe_json(resp)
    if data is None:
        return None, "上游返回非JSON"
    if isinstance(data, dict):
        err_code = data.get("ErrCode")
        if err_code not in (None, 0, "0", ""):
            return None, data.get("ErrMsg") or "上游返回错误"
    return data, None


def _fetch_fund_gz(code):
    url = f"https://fundgz.1234567.com.cn/js/{code}.js"
    try:
        resp = SESSION.get(url, timeout=5, verify=False)
        match = re.search(r'jsonpgz\((.*)\)', resp.text)
        if not match:
            return None, "未找到基金"
        data = json.loads(match.group(1))
        return {
            "code": data.get("fundcode", code),
            "name": data.get("name", ""),
            "nav": data.get("dwjz", ""),
            "nav_date": data.get("jzrq", ""),
            "estimate_nav": data.get("gsz", ""),
            "estimate_change": data.get("gszzl", "0"),
            "estimate_time": data.get("gztime", ""),
        }, None
    except (requests.RequestException, ValueError, json.JSONDecodeError) as e:
        return None, str(e)


# ==========================================
# 板块配置 - 完整的板块列表
# ==========================================

SECTOR_LIST = [
    # 科技
    {"name": "人工智能", "code": "BK000217", "category": "科技"},
    {"name": "半导体", "code": "BK000054", "category": "科技"},
    {"name": "云计算", "code": "BK000266", "category": "科技"},
    {"name": "5G概念", "code": "BK000291", "category": "科技"},
    {"name": "光模块", "code": "BK000651", "category": "科技"},
    {"name": "算力", "code": "BK000601", "category": "科技"},
    {"name": "生成式AI", "code": "BK000369", "category": "科技"},
    {"name": "消费电子", "code": "BK000089", "category": "科技"},
    # 新能源
    {"name": "新能源汽车", "code": "BK000225", "category": "新能源"},
    {"name": "光伏", "code": "BK000146", "category": "新能源"},
    {"name": "锂电池", "code": "BK000295", "category": "新能源"},
    {"name": "储能", "code": "BK000230", "category": "新能源"},
    {"name": "氢能源", "code": "BK000227", "category": "新能源"},
    {"name": "风电", "code": "BK000147", "category": "新能源"},
    {"name": "绿色电力", "code": "BK1036", "category": "新能源"},
    {"name": "电网设备", "code": "BK0920", "category": "新能源"},
    # 医药健康
    {"name": "医药", "code": "BK000090", "category": "医药健康"},
    {"name": "医疗器械", "code": "BK000095", "category": "医药健康"},
    {"name": "创新药", "code": "BK000315", "category": "医药健康"},
    {"name": "中药", "code": "BK000091", "category": "医药健康"},
    # 金融
    {"name": "银行", "code": "BK000121", "category": "金融"},
    {"name": "证券", "code": "BK000128", "category": "金融"},
    {"name": "保险", "code": "BK000127", "category": "金融"},
    # 消费
    {"name": "食品饮料", "code": "BK000074", "category": "消费"},
    {"name": "白酒", "code": "BK000076", "category": "消费"},
    {"name": "家用电器", "code": "BK000066", "category": "消费"},
    {"name": "汽车整车", "code": "BK000069", "category": "消费"},
    # 工业制造
    {"name": "机器人", "code": "BK000234", "category": "工业制造"},
    {"name": "人形机器人", "code": "BK000581", "category": "工业制造"},
    {"name": "自动驾驶", "code": "BK000279", "category": "工业制造"},
    {"name": "智能驾驶", "code": "BK000461", "category": "工业制造"},
    {"name": "国防军工", "code": "BK000156", "category": "工业制造"},
    {"name": "低空经济", "code": "BK000521", "category": "工业制造"},
    {"name": "商业航天", "code": "BK1132", "category": "工业制造"},
    # 周期资源
    {"name": "煤炭", "code": "BK000177", "category": "周期资源"},
    {"name": "钢铁", "code": "BK000043", "category": "周期资源"},
    {"name": "有色金属", "code": "BK000047", "category": "周期资源"},
    {"name": "贵金属", "code": "BK000050", "category": "周期资源"},
    {"name": "房地产", "code": "BK000105", "category": "周期资源"},
    # 其他
    {"name": "可控核聚变", "code": "BK1133", "category": "其他"},
    {"name": "交通运输", "code": "BK000112", "category": "其他"},
]

SECTOR_ALIAS_MAP = {
    "酿酒": "BK000076",
    "光伏设备": "BK000146",
    "电网设备": "BK0920",
}


def _map_sector_to_theme_code(sector_name):
    if not sector_name:
        return ""
    for item in SECTOR_LIST:
        if item["name"] in sector_name:
            return item["code"]
    for key, code in SECTOR_ALIAS_MAP.items():
        if key in sector_name:
            return code
    return ""


# ==========================================
# 基金模块
# ==========================================

def fund_search(keyword):
    """搜索基金 - 只返回场外基金"""
    cache_key = f"search:{keyword}"
    cached = get_cache(cache_key)
    if cached:
        return cached
    
    # 排除的类别：高端理财、场内基金(ETF/LOF除外)、货币基金等不支持详情查询的
    EXCLUDE_CATEGORIES = {"高端理财", "私募", "银行理财", "信托", "保险", "券商理财"}

    def _is_money_fund(category: str, ftype: str, name: str) -> bool:
        """货币基金识别：名称/分类/类型任一命中即剔除。"""
        category = category or ""
        ftype = ftype or ""
        name = name or ""
        if "货币" in category or "货币" in ftype or "货币" in name:
            return True
        if "现金" in category or "现金" in ftype or "现金" in name:
            return True
        return False
    
    data, err = _tiantian_action(
        "fundSearch",
        {"m": "1", "key": keyword, "pageindex": "0", "pagesize": "50"},
        timeout=6
    )
    if not data:
        return {"success": False, "message": f"搜索失败: {err or '上游不可用'}"}

    results = []
    if data.get("Datas"):
        for item in data["Datas"]:
            fund_base = item.get("FundBaseInfo") or {}
            category = item.get("CATEGORYDESC", "")
            ftype = fund_base.get("FTYPE", "")
            code = item.get("CODE", "")

            # 只保留场外基金：有 FundBaseInfo 且不在排除类别
            if not fund_base:
                continue
            if category in EXCLUDE_CATEGORIES:
                continue
            # 只保留6位代码的基金
            if not code or len(code) != 6:
                continue

            if _is_money_fund(category, ftype, item.get("NAME", "")):
                continue

            results.append({
                "code": code,
                "name": item.get("NAME", ""),
                "type": ftype,
                "category": category
            })

            if len(results) >= 20:
                break

    result = {"success": True, "data": results}
    set_cache(cache_key, result)
    return result


def fund_info(code):
    """获取单只基金信息"""
    cache_key = f"info:{code}"
    cached = get_cache(cache_key, ttl=30)
    if cached:
        return cached
    fund_data, err = _fetch_fund_gz(code)
    if fund_data:
        result = {"success": True, "data": fund_data}
        set_cache(cache_key, result, ttl=30)
        return result

    last_error = err or "估值数据为空"

    # 兜底：使用基金详情接口获取基础信息
    detail_data, detail_err = _tiantian_action(
        "fundMNDetailInformation",
        {"FCODE": code},
        timeout=6
    )
    if detail_data:
        datas = detail_data.get("Datas") or {}
        if datas:
            result = {
                "success": True,
                "data": {
                    "code": datas.get("FCODE", code),
                    "name": datas.get("SHORTNAME", "") or datas.get("FULLNAME", ""),
                    "nav": datas.get("DWJZ", ""),
                    "nav_date": datas.get("FSRQ", ""),
                    "estimate_nav": "",
                    "estimate_change": "",
                    "estimate_time": "",
                }
            }
            set_cache(cache_key, result, ttl=30)
            return result
    if detail_err:
        last_error = detail_err

    return {"success": False, "message": f"获取失败: {last_error}"}


def _fetch_fund_year_change(code):
    cache_key = f"fund_year_change:{code}"
    cached = get_cache(cache_key, ttl=FUND_DETAIL_PART_TTL)
    if cached is not None:
        return cached
    inc_data, _ = _tiantian_action(
        "fundMNPeriodIncrease",
        {"FCODE": code},
        timeout=6
    )
    if inc_data:
        for item in inc_data.get("Datas", []):
            title = item.get("title") or item.get("Title") or ""
            if title in ("1N", "近1年", "Y"):
                value = item.get("syl", "")
                set_cache(cache_key, value, ttl=FUND_DETAIL_PART_TTL)
                return value
    set_cache(cache_key, "", ttl=FUND_DETAIL_PART_TTL)
    return ""


def _fetch_fund_sectors(code):
    cache_key = f"fund_sectors:{code}"
    cached = get_cache(cache_key, ttl=FUND_DETAIL_PART_TTL)
    if cached is not None:
        return cached
    search_data, _ = _tiantian_action(
        "fundSearch",
        {"m": "1", "key": code},
        timeout=6
    )
    if search_data and search_data.get("Datas"):
        zt_info = search_data["Datas"][0].get("ZTJJInfo", [])
        if zt_info:
            result = [{"name": zt.get("TTYPENAME", ""), "code": zt.get("TTYPE", "")} for zt in zt_info[:3]]
            set_cache(cache_key, result, ttl=FUND_DETAIL_PART_TTL)
            return result
    set_cache(cache_key, [], ttl=FUND_DETAIL_PART_TTL)
    return []


def _fetch_stock_changes(codes):
    if not codes:
        return {}
    secids = []
    for code in codes:
        if not code:
            continue
        market = "1" if str(code).startswith(("6", "9")) else "0"
        secids.append(f"{market}.{code}")
    if not secids:
        return {}
    try:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "secids": ",".join(secids),
            "fields": "f12,f14,f3",
            "fltt": "2",
            "invt": "2"
        }
        resp = SESSION.get(url, params=params, timeout=6, verify=False)
        data = _safe_json(resp) or {}
        diff = data.get("data", {}).get("diff", [])
        result = {}
        for item in diff:
            code = item.get("f12")
            change = item.get("f3")
            if code is not None:
                result[code] = change
        return result
    except requests.RequestException:
        return {}


def _fetch_fund_stocks(code):
    cache_key = f"fund_stocks:{code}"
    cached = get_cache(cache_key, ttl=FUND_DETAIL_PART_TTL)
    if cached is not None:
        return cached
    stocks = []
    try:
        stocks_url = f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10"
        stocks_resp = SESSION.get(
            stocks_url,
            timeout=8,
            verify=False,
            headers={"Referer": "https://fundf10.eastmoney.com/"}
        )
        table_pattern = r'<tr[^>]*>.*?<td[^>]*>(\d+)</td>.*?<td[^>]*>(\d{6})</td>.*?<td[^>]*><a[^>]*>([^<]+)</a></td>.*?<td[^>]*>([^<]*)</td>'
        for match in re.finditer(table_pattern, stocks_resp.text, re.DOTALL):
            stocks.append({
                "rank": match.group(1),
                "code": match.group(2),
                "name": match.group(3).strip(),
                "ratio": match.group(4).strip() + "%",
                "change": ""
            })
        if not stocks:
            simple_pattern = r'<a[^>]*>(\d{6})</a>.*?<a[^>]*>([^<]+)</a>.*?(\d+\.\d+)%'
            for match in re.finditer(simple_pattern, stocks_resp.text, re.DOTALL):
                stocks.append({
                    "code": match.group(1),
                    "name": match.group(2).strip(),
                    "ratio": match.group(3) + "%",
                    "change": ""
                })
    except requests.RequestException:
        return []

    changes = _fetch_stock_changes([s.get("code") for s in stocks])
    for s in stocks:
        if s.get("code") in changes:
            s["change"] = changes.get(s["code"])
    result = stocks[:10]
    set_cache(cache_key, result, ttl=FUND_DETAIL_PART_TTL)
    return result


def fund_detail(code):
    """获取基金详细信息，包含重仓股"""
    cache_key = f"detail:{code}"
    cached = get_cache(cache_key, ttl=60)
    if cached:
        return cached

    info_result = fund_info(code)
    if not info_result.get("success"):
        return info_result
    
    fund_data = info_result["data"].copy()
    detail_data, _ = _tiantian_action(
        "fundMNDetailInformation",
        {"FCODE": code},
        timeout=6
    )
    datas = detail_data.get("Datas") if isinstance(detail_data, dict) else {}
    if datas:
        fund_data.setdefault("name", datas.get("SHORTNAME", "") or datas.get("FULLNAME", ""))
        if not fund_data.get("nav"):
            fund_data["nav"] = datas.get("DWJZ", "")
        if not fund_data.get("nav_date"):
            fund_data["nav_date"] = datas.get("FSRQ", "")
        fund_data["perf_cmp"] = datas.get("PERFCMP", "")
        fund_data["inv_tgt"] = datas.get("INVTGT", "")
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            "stocks": executor.submit(_fetch_fund_stocks, code),
            "year_change": executor.submit(_fetch_fund_year_change, code),
            "sectors": executor.submit(_fetch_fund_sectors, code)
        }
        fund_data["stocks"] = futures["stocks"].result()
        fund_data["year_change"] = futures["year_change"].result() or fund_data.get("year_change", "")
        fund_data["sectors"] = futures["sectors"].result()

    result = {"success": True, "data": fund_data}
    set_cache(cache_key, result, ttl=60)
    return result


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
    cached = get_cache(cache_key, ttl=FUND_HOT_TTL)
    if cached:
        return cached

    data, err = _tiantian_action(
        "fundMNRank",
        {
            "FundType": "0",
            "SortColumn": "SALESRANK_D",
            "Sort": "desc",
            "pageIndex": "1",
            "pageSize": "20"
        },
        timeout=8
    )
    if data and data.get("Datas"):
        results = []
        for item in data["Datas"]:
            code = item.get("FCODE", "")
            name = item.get("SHORTNAME", "") or item.get("FULLNAME", "")
            change = item.get("RZDF") or "0"
            if not code or len(code) != 6:
                continue
            if "货币" in (name or ""):
                continue
            results.append({
                "code": code,
                "name": name,
                "change": change,
                "type": ""
            })
            if len(results) >= 20:
                break
        if results:
            result = {"success": True, "data": results}
            set_cache(cache_key, result, ttl=FUND_HOT_TTL)
            return result

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

        text = resp.text
        match = re.search(r'datas:\[(.*?)\]', text)
        if not match:
            return {"success": False, "message": "解析数据失败"}

        results = []
        items = match.group(1).split('","')
        for item in items[:20]:
            parts = item.strip('"').split(',')
            if len(parts) >= 7:
                if "货币" in (parts[1] or ""):
                    # 过滤货币型基金，避免进入详情页无有效数据
                    continue
                results.append({
                    "code": parts[0],
                    "name": parts[1],
                    "change": parts[6] if parts[6] else "0",
                    "type": "混合型"
                })

        result = {"success": True, "data": results}
        set_cache(cache_key, result, ttl=FUND_HOT_TTL)
        return result
    except requests.RequestException as e:
        return {"success": False, "message": f"获取热门失败: {str(e)}"}




# ==========================================
# 市场模块
# ==========================================

def market_indices():
    """获取主要指数"""
    cache_key = "indices"
    cached = get_cache(cache_key, ttl=30)
    if cached:
        return cached

    try:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "fltt": "2",
            "secids": "1.000001,0.399001,0.399006,1.000300",
            "fields": "f2,f3,f4,f12,f14"
        }
        resp = SESSION.get(url, params=params, timeout=8, verify=False)
        data = _safe_json(resp) or {}

        indices = []
        for item in data.get("data", {}).get("diff", []) or []:
            change = item.get("f4", 0) or 0
            change_pct = item.get("f3", 0) or 0
            indices.append({
                "name": item.get("f14", ""),
                "value": str(item.get("f2", 0)),
                "change": f"{'+' if change >= 0 else ''}{change}",
                "change_percent": f"{'+' if change_pct >= 0 else ''}{change_pct}%"
            })

        if indices:
            result = {"success": True, "data": indices}
            set_cache(cache_key, result, ttl=30)
            return result
    except requests.RequestException as e:
        last_error = str(e)
    else:
        last_error = "指数数据为空"

    # 备用方案：腾讯财经
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
                indices.append({
                    "name": names[i] if i < len(names) else parts[1],
                    "value": parts[3],
                    "change": parts[31],
                    "change_percent": f"{parts[32]}%"
                })

        if indices:
            result = {"success": True, "data": indices}
            set_cache(cache_key, result, ttl=30)
            return result
    except requests.RequestException as e:
        last_error = str(e)

    return {"success": False, "message": f"获取指数失败: {last_error}"}


# ==========================================
# 板块模块
# ==========================================

def sector_list():
    """获取板块列表"""
    cache_key = "sector_list"
    cached = get_cache(cache_key, ttl=300)
    if cached:
        return cached
    
    try:
        # 使用东方财富行业板块API - 使用URL编码的空格
        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "fid": "f62",
            "po": "1",
            "pz": "100",
            "pn": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "ut": EASTMONEY_UT,
            "fs": "m:90+t:2",
            "fields": "f12,f14,f2,f3,f62,f184,f104,f105"
        }
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = _safe_json(resp)
        
        sectors = []
        if data and data.get("data", {}).get("diff"):
            for item in data["data"]["diff"]:
                change = item.get("f3", 0)
                if change == "-" or change is None:
                    change = 0
                try:
                    change_val = float(change)
                except (ValueError, TypeError):
                    change_val = 0
                sectors.append({
                    "name": item.get("f14", ""),
                    "code": item.get("f12", ""),
                    "change_percent": f"{'+' if change_val >= 0 else ''}{change_val}%",
                    "up_count": item.get("f104", 0),
                    "down_count": item.get("f105", 0),
                })
        
        if not sectors:
            return {"success": False, "message": "板块数据为空"}

        result = {"success": True, "data": sectors}
        set_cache(cache_key, result, ttl=300)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块失败: {str(e)}"}


def _calc_sector_streak_days(sector_code):
    """根据最近日K计算板块连涨/连跌天数"""
    # 单板块连涨结果缓存，减少重复K线请求
    cache_key = f"sector_streak:{sector_code}"
    cached = get_cache(cache_key, ttl=SECTOR_STREAK_ITEM_TTL)
    if cached is not None:
        return cached
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    params = {
        "secid": f"90.{sector_code}",
        "klt": "101",
        "fqt": "1",
        "lmt": "10",
        "end": "20500101",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "ut": EASTMONEY_UT
    }
    resp = SESSION.get(url, params=params, timeout=10, verify=False)
    data = resp.json()
    if not data.get("data", {}).get("klines"):
        return 0

    klines = data["data"]["klines"]
    if len(klines) < 2:
        return 0

    closes = []
    for item in klines:
        parts = item.split(",")
        if len(parts) >= 3:
            try:
                closes.append(float(parts[2]))
            except ValueError:
                continue

    if len(closes) < 2:
        return 0

    streak = 0
    last_sign = 0
    for i in range(len(closes) - 1, 0, -1):
        diff = closes[i] - closes[i - 1]
        sign = 1 if diff > 0 else -1 if diff < 0 else 0
        if sign == 0:
            break
        if last_sign == 0:
            last_sign = sign
            streak = 1 if sign > 0 else -1
            continue
        if sign == last_sign:
            streak = streak + 1 if sign > 0 else streak - 1
        else:
            break
    set_cache(cache_key, streak, ttl=SECTOR_STREAK_ITEM_TTL)
    return streak


def sector_streak(limit: int = None):
    """获取板块连涨/连跌数据"""
    limit_key = str(limit) if limit else "all"
    cache_key = f"sector_streak:{limit_key}"
    cached = get_cache(cache_key, ttl=SECTOR_STREAK_TTL)
    if cached:
        return cached
    
    try:
        list_result = sector_list()
        if not list_result.get("success"):
            return list_result
        
        sectors = list_result["data"]
        if limit:
            sectors = sectors[:limit]
        results = []

        max_workers = min(12, max(1, len(sectors)))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_calc_sector_streak_days, s["code"]): s for s in sectors}
            for future in as_completed(futures):
                sector = futures[future]
                try:
                    streak = future.result()
                except Exception:
                    streak = 0
                sector = sector.copy()
                sector["streak_days"] = streak
                results.append(sector)

        code_order = {s["code"]: i for i, s in enumerate(sectors)}
        results.sort(key=lambda x: code_order.get(x.get("code", ""), 999))

        result = {"success": True, "data": results}
        set_cache(cache_key, result, ttl=SECTOR_STREAK_TTL)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块数据失败: {str(e)}"}


def _fetch_sector_funds_by_code(sector_code):
    url = "https://fund.eastmoney.com/data/FundGuideapi.aspx"
    params = {
        "dt": "4", "sd": "", "ed": "", "tp": sector_code,
        "sc": "1n", "st": "desc", "pi": "1", "pn": "200",
        "zf": "diy", "sh": "list", "rnd": str(random.random())
    }
    headers = {
        "Referer": "https://fund.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
    resp = SESSION.get(url, params=params, headers=headers, timeout=15, verify=False)
    text = resp.text.replace("var rankData =", "").strip()
    if text.endswith(";"):
        text = text[:-1]
    data = json.loads(text)
    funds = []
    for item in data.get("datas", []):
        parts = item.split(",")
        if len(parts) >= 20:
            funds.append({
                "code": parts[0],
                "name": parts[1],
                "type": parts[3] if len(parts) > 3 else "",
                "change": parts[16] if len(parts) > 16 and parts[16] else "0",
                "year_change": parts[9] if len(parts) > 9 else "0"
            })
    return funds


def sector_funds(sector_code, sector_name=""):
    """获取板块内基金列表"""
    cache_key = f"sector_funds:{sector_code}"
    cached = get_cache(cache_key, ttl=SECTOR_FUNDS_TTL)
    if cached:
        return cached
    
    try:
        funds = _fetch_sector_funds_by_code(sector_code)
        if not funds and sector_name:
            theme_code = _map_sector_to_theme_code(sector_name)
            if theme_code and theme_code != sector_code:
                funds = _fetch_sector_funds_by_code(theme_code)
        
        if not funds:
            return {"success": False, "message": "板块基金数据为空"}

        result = {"success": True, "data": funds, "sector_name": sector_name}
        set_cache(cache_key, result, ttl=SECTOR_FUNDS_TTL)
        return result
    except Exception as e:
        return {"success": False, "message": f"获取板块基金失败: {str(e)}"}


# ==========================================
# 资讯模块
# ==========================================

def news_list():
    """获取基金相关资讯"""
    cache_key = "news_list"
    cached = get_cache(cache_key, ttl=300)
    if cached:
        return cached
    
    # 使用新浪财经滚动资讯
    try:
        url = "https://feed.mix.sina.com.cn/api/roll/get"
        params = {"pageid": "153", "lid": "2517", "num": "20", "page": "1"}
        resp = SESSION.get(url, params=params, timeout=10, verify=False)
        data = resp.json()
        
        news = []
        items = data.get("result", {}).get("data", [])
        for item in items[:20]:
            title = item.get("title", "")
            summary = item.get("summary") or item.get("intro") or item.get("wapsummary") or ""
            source = item.get("media_name", "新浪财经")
            ctime = item.get("ctime") or item.get("intime")
            try:
                ts = int(ctime)
                time_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
            except Exception:
                time_str = ""
            url = item.get("url") or item.get("wapurl") or ""
            if title:
                news.append({
                    "title": title,
                    "summary": summary,
                    "source": source,
                    "time": time_str,
                    "url": url
                })
        
        if news:
            result = {"success": True, "data": news}
            set_cache(cache_key, result, ttl=300)
            return result
    except Exception:
        pass

    return {"success": False, "message": "资讯数据获取失败"}


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
    
    # 板块模块
    if module == 'sector':
        if action == 'list':
            return sector_list()
        elif action == 'streak':
            raw_limit = params.get('limit', [''])[0]
            try:
                limit = int(raw_limit) if raw_limit else None
            except ValueError:
                limit = None
            return sector_streak(limit)
        elif action == 'funds':
            code = params.get('code', [''])[0]
            name = params.get('name', [''])[0]
            if code:
                return sector_funds(code, name)
            return {"success": False, "message": "请提供板块代码"}
    
    # 资讯模块
    if module == 'news':
        if action == 'list':
            return news_list()
    
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
