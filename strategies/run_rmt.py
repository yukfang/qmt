#coding:gbk
# ==================== parameters: edit only this block ====================
TOKEN = ''                    # same value as server BRIDGE_TOKEN
STRATEGY_ID = 'order_status'  # id in strategies/registry.json on the server
PARAMS = {}                   # overrides for the remote strategy's globals, e.g. {'POLL_SEC': 5}
AUTO_RELOAD = True            # pick up new versions from the server without restarting
RELOAD_CHECK_SEC = 30         # how often to ask the server for the current version
BASE_URL = 'https://qmt-console.enrichlife.today'
STRATEGY_PATH = '/api/strategies/{id}'  # download path on BASE_URL; {id} becomes STRATEGY_ID
LOG_PATH = '/api/logs'                  # where loader logs are posted
# ==========================================================================
"""
Remote strategy loader. Keep this file ASCII-only.

The remote source runs in its own namespace. For every function it defines, this module
gets a same-named forwarder, so callbacks QMT looks up by name (ContextInfo.run_time
'bridge_poll', ...) always reach the current version.

Hot reload: forwarders and handlebar ask the server (at most every RELOAD_CHECK_SEC) whether
the sha256 changed. A new version is exec'd into a fresh namespace; only if that succeeds
does it replace the old one. The remote init is NOT called again (it would register timers
twice). Remote strategies may declare:
  RELOAD_KEEP = ['_LOG_BUF', ...]   globals carried over from the old version
  def on_reload(ContextInfo): ...    called after a reload
Changing a timer period or the callback names still needs a restart.

Run it with a chart attached ("[quote]start simulation mode" appears in the log).
"""
LOADER_VERSION = 'rmt-v10'
LOADER_SOURCE = 'rmt'
LOADER_UA = 'QMT-Bridge/1.0'
_LOADER = {
    'ns': None, 'sha': '', 'version': '', 'last_check': 0.0, 'checking': False,
    'remote_handlebar': None, 'handlebar_calls': 0, 'reloads': 0, 'exported': set(),
}
_LOADER_OWN = set([
    'TOKEN', 'STRATEGY_ID', 'PARAMS', 'AUTO_RELOAD', 'RELOAD_CHECK_SEC', 'BASE_URL',
    'STRATEGY_PATH', 'LOG_PATH', 'init', 'handlebar',
])


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
                return int(code), e.read().decode('utf-8', 'replace')
            except Exception:
                return int(code), ''
        return -1, '%s %s' % (type(e).__name__, e)


def _loader_log(message, level='info'):
    import time
    print('[%s] %s' % (LOADER_VERSION, message))
    off = -time.timezone
    ts = '%s%s%02d:%02d' % (time.strftime('%Y-%m-%dT%H:%M:%S'), '+' if off >= 0 else '-',
                            abs(off) // 3600, (abs(off) % 3600) // 60)
    code, content = _loader_http(LOG_PATH, {
        'source': LOADER_SOURCE,
        'lines': [{'ts': ts, 'level': level,
                   'message': '%s %s: %s' % (LOADER_VERSION, STRATEGY_ID, message)}],
    })
    if code != 200:
        print('[%s] log upload failed http=%s %s' % (LOADER_VERSION, code, str(content)[:300]))


def _loader_is_own(name):
    return name in _LOADER_OWN or name.startswith('_loader') or name.startswith('_LOADER') \
        or name.startswith('LOADER_')


def _loader_strategy_path():
    path = STRATEGY_PATH.replace('{id}', STRATEGY_ID)
    return path if path.startswith('/') else '/' + path


def _loader_download(meta_only=False):
    import hashlib
    import json
    path = _loader_strategy_path()
    if meta_only:
        path += ('&' if '?' in path else '?') + 'meta=1'
    code, content = _loader_http(path)
    if code != 200:
        raise RuntimeError('download http=%s body=%s' % (code, str(content)[:500]))
    data = json.loads(content)
    if meta_only:
        return data
    source = data.get('code') or ''
    digest = hashlib.sha256(source.encode('utf-8')).hexdigest()
    if not source or digest != data.get('sha256'):
        raise RuntimeError('sha256 mismatch got=%s want=%s' % (digest[:12], str(data.get('sha256'))[:12]))
    return data


def _loader_build_ns(data, old_ns):
    """Exec the source in a fresh namespace that sees what QMT injected into this module."""
    g = globals()
    ns = {}
    for key, value in g.items():
        if _loader_is_own(key) or getattr(value, 'rmt_forwarder', False):
            continue
        ns[key] = value
    exec(compile(data['code'], 'remote:%s' % data.get('file'), 'exec'), ns)
    if old_ns is not None:
        for key in ns.get('RELOAD_KEEP') or []:
            if key in old_ns:
                ns[key] = old_ns[key]
    applied = {}
    for key, value in (data.get('params') or {}).items():
        ns[key] = value
        applied[key] = 'server'
    for key, value in PARAMS.items():
        ns[key] = value
        applied[key] = 'local'
    ns['TOKEN'] = TOKEN
    ns['BASE_URL'] = BASE_URL
    return ns, applied


def _loader_forwarder(name):
    def forward(*args, **kwargs):
        if args:
            _loader_maybe_reload(args[0])
        return _LOADER['ns'][name](*args, **kwargs)
    forward.__name__ = name
    forward.rmt_forwarder = True
    return forward


def _loader_export(ns):
    """Give every function of the remote namespace a same-named forwarder in this module."""
    import types
    g = globals()
    names = set()
    for key, value in ns.items():
        if key in ('init', 'handlebar') or _loader_is_own(key):
            continue
        if isinstance(value, types.FunctionType) and value.__globals__ is ns:
            names.add(key)
            if not getattr(g.get(key), 'rmt_forwarder', False):
                g[key] = _loader_forwarder(key)
    _LOADER['exported'] = names
    return names


def _loader_activate(data, ns):
    import time
    _LOADER['ns'] = ns
    _LOADER['sha'] = data.get('sha256') or ''
    _LOADER['version'] = ns.get('STRATEGY_VERSION', data.get('version') or '?')
    _LOADER['last_check'] = time.time()
    hb = ns.get('handlebar')
    _LOADER['remote_handlebar'] = hb if callable(hb) else None
    _loader_export(ns)


def _loader_maybe_reload(ContextInfo):
    import time
    import traceback
    if not AUTO_RELOAD or _LOADER['ns'] is None or _LOADER['checking']:
        return
    now = time.time()
    if now - _LOADER['last_check'] < RELOAD_CHECK_SEC:
        return
    _LOADER['last_check'] = now
    _LOADER['checking'] = True
    try:
        meta = _loader_download(meta_only=True)
        if not meta.get('sha256') or meta.get('sha256') == _LOADER['sha']:
            return
        old_version = _LOADER['version']
        data = _loader_download()
        ns, applied = _loader_build_ns(data, _LOADER['ns'])
        if not callable(ns.get('init')):
            raise RuntimeError('new version has no init()')
        _loader_activate(data, ns)
        _LOADER['reloads'] += 1
        _loader_log('reloaded %s -> %s sha256=%s keep=%s' % (
            old_version, _LOADER['version'], _LOADER['sha'][:12], ns.get('RELOAD_KEEP') or []))
        hook = ns.get('on_reload')
        if callable(hook):
            hook(ContextInfo)
    except Exception:
        _loader_log('reload failed, keep %s\n%s' % (_LOADER['version'], traceback.format_exc()), 'error')
    finally:
        _LOADER['checking'] = False


def init(ContextInfo):
    import traceback
    _loader_log('init called token_len=%s auto_reload=%s url=%s%s' % (
        len(TOKEN), AUTO_RELOAD, BASE_URL.rstrip('/'), _loader_strategy_path()))
    try:
        data = _loader_download()
        _loader_log('downloaded %s version=%s bytes=%s sha256=%s' % (
            data.get('file'), data.get('version') or '?', data.get('bytes'), str(data.get('sha256'))[:12]))
        ns, applied = _loader_build_ns(data, None)
        if not callable(ns.get('init')):
            _loader_log('remote strategy has no init()', 'error')
            return
        _loader_activate(data, ns)
        if applied:
            _loader_log('params %s' % ', '.join(
                '%s=%r(%s)' % (k, ns.get(k), applied[k]) for k in sorted(applied)))
        public = sorted(k for k in _LOADER['exported'] if not k.startswith('_'))
        _loader_log('exported %s functions, public: %s' % (len(_LOADER['exported']), ', '.join(public)))
    except Exception:
        _loader_log('load failed\n%s' % traceback.format_exc(), 'error')
        return
    _loader_log('calling remote init version=%s' % _LOADER['version'])
    try:
        _LOADER['ns']['init'](ContextInfo)
    except Exception:
        _loader_log('remote init failed\n%s' % traceback.format_exc(), 'error')
        return
    _loader_log('remote init returned')


def handlebar(ContextInfo):
    _LOADER['handlebar_calls'] += 1
    if _LOADER['handlebar_calls'] == 1:
        _loader_log('handlebar called remote=%s' % bool(_LOADER['remote_handlebar']))
    _loader_maybe_reload(ContextInfo)
    fn = _LOADER['remote_handlebar']
    if fn is None:
        return
    try:
        return fn(ContextInfo)
    except Exception:
        import traceback
        _loader_log('remote handlebar failed\n%s' % traceback.format_exc(), 'error')


print('[%s] module loaded id=%s token_len=%s' % (LOADER_VERSION, STRATEGY_ID, len(TOKEN)))
