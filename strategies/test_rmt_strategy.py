#coding:gbk
TOKEN = ''  # same value as server BRIDGE_TOKEN
"""
Remote strategy loader. Run live, not backtest. Keep this file ASCII-only.

init downloads GET /api/strategies/{STRATEGY_ID} and execs it in this module's globals(),
then calls the downloaded init. Callbacks registered with ContextInfo.run_time (e.g. bridge_poll)
are looked up by name in this module, so the source must run in globals().

OVERRIDES are written back after exec. Fill TOKEN here only; remote sources keep it empty.
"""
LOADER_VERSION = 'rmt-v6'
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
    print('[%s] %s' % (LOADER_VERSION, message))
    off = -time.timezone
    ts = '%s%s%02d:%02d' % (time.strftime('%Y-%m-%dT%H:%M:%S'), '+' if off >= 0 else '-',
                            abs(off) // 3600, (abs(off) % 3600) // 60)
    code, content = _loader_http('/api/logs', {
        'source': LOADER_SOURCE,
        'lines': [{'ts': ts, 'level': level, 'message': '%s: %s' % (STRATEGY_ID, message)}],
    })
    if code != 200:
        print('[%s] log upload failed http=%s %s' % (LOADER_VERSION, code, str(content)[:300]))


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


def _loader_wrap(g, name):
    fn = g.get(name)
    if not callable(fn):
        return
    state = {'first': True}

    def wrapped(ContextInfo, *args, **kwargs):
        if state['first']:
            state['first'] = False
            _loader_log('%s called' % name)
        try:
            return fn(ContextInfo, *args, **kwargs)
        except Exception:
            import traceback
            _loader_log('%s failed\n%s' % (name, traceback.format_exc()), 'error')
            raise

    wrapped.__name__ = name
    g[name] = wrapped


def _loader_boot():
    g = globals()
    loader = {
        'TOKEN': TOKEN, 'BASE_URL': BASE_URL, 'STRATEGY_ID': STRATEGY_ID, 'OVERRIDES': OVERRIDES,
    }
    _loader_log('boot base=%s token_len=%s' % (BASE_URL, len(TOKEN)))
    source, meta = _loader_fetch(STRATEGY_ID)
    _loader_log('downloaded %s version=%s bytes=%s sha256=%s' % (
        meta.get('file'), meta.get('version') or '?', meta.get('bytes'), str(meta.get('sha256'))[:12]))
    exec(compile(source, 'remote:%s' % meta.get('file'), 'exec'), g)
    g.update(loader)
    _loader_apply_overrides(g)
    if not callable(g.get('init')):
        raise RuntimeError('remote strategy has no init()')
    _loader_wrap(g, 'init')
    _loader_wrap(g, 'handlebar')
    _loader_log('ready remote_version=%s, waiting for QMT to call init' % g.get('STRATEGY_VERSION', '?'))


def init(ContextInfo):
    _loader_log('init called but remote strategy was not loaded', 'error')


def handlebar(ContextInfo):
    return


try:
    _loader_boot()
except BaseException:
    import traceback
    _loader_log('boot failed\n%s' % traceback.format_exc(), 'error')
