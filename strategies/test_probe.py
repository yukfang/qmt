#coding:gbk
TOKEN = ''  # same value as server BRIDGE_TOKEN
"""
Probe v2: inside init, download a remote strategy (hardcoded REMOTE_ID), exec it into this
module's globals() so ContextInfo.run_time callbacks resolve by name, then call its init.
handlebar prints what happened. Keep this file ASCII-only.
"""
PROBE_VERSION = 'probe-v2'
BASE_URL = 'https://qmt-console.enrichlife.today'
REMOTE_ID = 'order_status'
PROBE = {'init': 0, 'handlebar': 0, 'steps': []}


def _step(message):
    PROBE['steps'].append(message)
    print('[%s] %s' % (PROBE_VERSION, message))


def _http(path):
    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen
        req = Request(BASE_URL + path)
        req.add_header('User-Agent', 'QMT-Bridge/1.0')
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


def _load_remote(ContextInfo):
    import hashlib
    import json
    import traceback
    code, content = _http('/api/strategies/%s' % REMOTE_ID)
    if code != 200:
        _step('download failed http=%s body=%s' % (code, content[:300]))
        return
    data = json.loads(content)
    source = data.get('code') or ''
    digest = hashlib.sha256(source.encode('utf-8')).hexdigest()
    _step('downloaded %s bytes=%s sha256=%s match=%s' % (
        data.get('file'), data.get('bytes'), digest[:12], digest == data.get('sha256')))
    g = globals()
    mine = {'init': g['init'], 'handlebar': g['handlebar'], 'TOKEN': TOKEN, 'BASE_URL': BASE_URL}
    try:
        exec(compile(source, 'remote:%s' % data.get('file'), 'exec'), g)
    except Exception:
        _step('exec failed\n%s' % traceback.format_exc())
        return
    remote_init = g.get('init')
    g.update(mine)
    remote_version = g.get('STRATEGY_VERSION', '?')
    if not callable(remote_init) or remote_init is mine['init']:
        _step('remote has no init()')
        return
    _step('exec ok remote_version=%s, calling remote init' % remote_version)
    try:
        remote_init(ContextInfo)
    except Exception:
        _step('remote init failed\n%s' % traceback.format_exc())
        return
    _step('remote init returned')


def init(ContextInfo):
    PROBE['init'] += 1
    _step('init called token_len=%s' % len(TOKEN))
    _load_remote(ContextInfo)


def handlebar(ContextInfo):
    PROBE['handlebar'] += 1
    if PROBE['handlebar'] <= 3:
        print('[%s] handlebar #%s init_calls=%s steps=%s module=%s' % (
            PROBE_VERSION, PROBE['handlebar'], PROBE['init'], len(PROBE['steps']), __name__))


print('[%s] module loaded name=%s' % (PROBE_VERSION, __name__))
