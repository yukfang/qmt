#coding:gbk
"""
远程策略加载器。实盘启动，不要回测。

init 时按 STRATEGY_ID 从 GET /api/strategies/{id} 下载源码，在本文件的全局空间里执行，
再调用下载策略的 init。下载策略里用 ContextInfo.run_time 注册的回调（如 bridge_poll）
按函数名在本模块里查找，所以源码必须执行在 globals() 里。

OVERRIDES 在源码执行后写回全局变量，TOKEN 等只在这里填，远程源码里保持为空。
"""
TOKEN = ''  # 与服务器 BRIDGE_TOKEN 相同
BASE_URL = 'https://qmt-console.enrichlife.today'
STRATEGY_ID = 'order_status'
OVERRIDES = {}

LOADER_SOURCE = 'rmt'
LOADER_UA = 'QMT-Bridge/1.0'


def _loader_http(path, payload=None):
    import json
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=True, default=str).encode('utf-8')
    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen
        req = Request(BASE_URL.rstrip('/') + path, data=body)
        req.add_header('User-Agent', LOADER_UA)
        if body is not None:
            req.add_header('Content-Type', 'application/json')
        if TOKEN:
            req.add_header('X-Bridge-Token', TOKEN)
        resp = urlopen(req, timeout=15)
        return resp.getcode(), resp.read().decode('utf-8', 'replace')
    except Exception as e:
        code = getattr(e, 'code', None)
        if code is not None and hasattr(e, 'read'):
            try:
                content = e.read().decode('utf-8', 'replace')
            except Exception:
                content = ''
            return int(code), content
        return -1, '%s %s' % (type(e).__name__, e)


def _loader_log(message, level='info'):
    import time
    print('[rmt] %s' % message)
    _loader_http('/api/logs', {
        'source': LOADER_SOURCE,
        'lines': [{'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'level': level,
                   'message': '%s: %s' % (STRATEGY_ID, message)}],
    })


def _loader_fetch(strategy_id):
    import hashlib
    import json
    code, content = _loader_http('/api/strategies/%s' % strategy_id)
    if code != 200:
        raise RuntimeError('download http=%s body=%s' % (code, str(content)[:500]))
    data = json.loads(content)
    source = data.get('code') or ''
    digest = hashlib.sha256(source.encode('utf-8')).hexdigest()
    if not source or digest != data.get('sha256'):
        raise RuntimeError('sha256 mismatch: got %s want %s' % (digest[:12], str(data.get('sha256'))[:12]))
    return source, data


def _loader_apply_overrides(g):
    g['BASE_URL'] = BASE_URL
    if TOKEN:
        g['TOKEN'] = TOKEN
    for key, value in OVERRIDES.items():
        g[key] = value


def init(ContextInfo):
    g = globals()
    loader_init = g['init']
    loader = {
        'TOKEN': TOKEN, 'BASE_URL': BASE_URL, 'STRATEGY_ID': STRATEGY_ID, 'OVERRIDES': OVERRIDES,
    }
    try:
        source, meta = _loader_fetch(STRATEGY_ID)
    except Exception as e:
        _loader_log('load failed: %s %s' % (type(e).__name__, e), 'error')
        return
    _loader_log('downloaded %s bytes=%s sha256=%s' % (meta.get('file'), meta.get('bytes'), str(meta.get('sha256'))[:12]))
    try:
        exec(compile(source, 'remote:%s' % meta.get('file'), 'exec'), g)
    except Exception:
        import traceback
        _loader_log('exec failed\n%s' % traceback.format_exc(), 'error')
        return
    g.update(loader)
    _loader_apply_overrides(g)
    remote_init = g.get('init')
    if remote_init is None or remote_init is loader_init:
        _loader_log('remote strategy has no init()', 'error')
        return
    _loader_log('start init')
    try:
        remote_init(ContextInfo)
    except Exception:
        import traceback
        _loader_log('remote init failed\n%s' % traceback.format_exc(), 'error')


def handlebar(ContextInfo):
    return
