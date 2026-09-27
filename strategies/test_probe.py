#coding:gbk
"""
Probe: does QMT call init in this run mode, can init reach the network, is init's print shown?
init records into a module global and ContextInfo; handlebar prints what init recorded.
"""
PROBE_VERSION = 'probe-v1'
BASE_URL = 'https://qmt-console.enrichlife.today'
PROBE = {'init': 0, 'init_http': '', 'handlebar': 0}


def _health():
    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen
        req = Request(BASE_URL + '/api/health')
        req.add_header('User-Agent', 'QMT-Bridge/1.0')
        resp = urlopen(req, timeout=10)
        return 'http %s' % resp.getcode()
    except Exception as e:
        return '%s %s' % (type(e).__name__, e)


def init(ContextInfo):
    PROBE['init'] += 1
    print('[%s] probe init called' % PROBE_VERSION)
    PROBE['init_http'] = _health()
    try:
        ContextInfo.probe_init = PROBE['init_http']
    except Exception as e:
        PROBE['ctx_err'] = '%s %s' % (type(e).__name__, e)


def handlebar(ContextInfo):
    PROBE['handlebar'] += 1
    if PROBE['handlebar'] <= 3:
        print('[' + PROBE_VERSION + '] probe handlebar #%s init_calls=%s init_http=%s ctx=%s module=%s' % (
            PROBE['handlebar'], PROBE['init'], PROBE['init_http'],
            getattr(ContextInfo, 'probe_init', None), __name__))
        if PROBE['handlebar'] == 1:
            print('[%s] probe handlebar http=%s' % (PROBE_VERSION, _health()))


print('[%s] probe module loaded name=%s' % (PROBE_VERSION, __name__))
