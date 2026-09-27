#coding:gbk
TOKEN = ''  # same value as server BRIDGE_TOKEN
"""
Remote strategy loader. Run live, not backtest. Keep this file ASCII-only.

init downloads GET /api/strategies/{STRATEGY_ID} and execs it in this module's globals(),
then calls the downloaded init. Callbacks registered with ContextInfo.run_time (e.g. bridge_poll)
are looked up by name in this module, so the source must run in globals().

OVERRIDES are written back after exec. Fill TOKEN here only; remote sources keep it empty.
"""
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
    off = -time.timezone
    ts = '%s%s%02d:%02d' % (time.strftime('%Y-%m-%dT%H:%M:%S'), '+' if off >= 0 else '-',
                            abs(off) // 3600, (abs(off) % 3600) // 60)
    code, content = _loader_http('/api/logs', {
        'source': LOADER_SOURCE,
        'lines': [{'ts': ts, 'level': level, 'message': '%s: %s' % (STRATEGY_ID, message)}],
    })
    if code != 200:
        print('[rmt] log upload failed http=%s %s' % (code, str(content)[:300]))


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


def _loader_run(ContextInfo):
    g = globals()
    loader = {
        'TOKEN': TOKEN, 'BASE_URL': BASE_URL, 'STRATEGY_ID': STRATEGY_ID, 'OVERRIDES': OVERRIDES,
    }
    _loader_log('init enter base=%s token_len=%s globals_has_init=%s' % (BASE_URL, len(TOKEN), 'init' in g))
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
    if remote_init is None or getattr(remote_init, 'rmt_loader', False):
        _loader_log('remote strategy has no init()', 'error')
        return
    _loader_log('start init')
    try:
        remote_init(ContextInfo)
    except Exception:
        import traceback
        _loader_log('remote init failed\n%s' % traceback.format_exc(), 'error')
        return
    _loader_log('remote init returned')


def init(ContextInfo):
    print('[rmt] init called id=%s' % STRATEGY_ID)
    try:
        _loader_run(ContextInfo)
    except BaseException:
        import traceback
        text = traceback.format_exc()
        print('[rmt] loader crashed\n%s' % text)
        try:
            _loader_log('loader crashed\n%s' % text, 'error')
        except BaseException:
            pass


init.rmt_loader = True


def handlebar(ContextInfo):
    return


print('[rmt] module loaded id=%s token_len=%s' % (STRATEGY_ID, len(TOKEN)))
try:
    _loader_log('module loaded token_len=%s' % len(TOKEN))
except BaseException as _e:
    print('[rmt] module log failed %s %s' % (type(_e).__name__, _e))
