#coding:gbk
"""
已在银河 QMT「模型研究」回测中跑通（2026-09-15）。

作用：取 159781.SZ 的 get_full_tick 快照，POST 一次到 httpcan，打印 response。
用法：全文贴进新建 python 策略 → 保存 → 回测（周期 1分钟即可）。
"""

STOCK = '159781.SZ'
URL = 'http://httpcan.okiedokie.work/anything'

def init(ContextInfo):
    ContextInfo.sent = False
    ContextInfo.set_universe([STOCK])

def handlebar(ContextInfo):
    if ContextInfo.sent:
        return
    ContextInfo.sent = True

    data = ContextInfo.get_full_tick([STOCK])
    print('tick:', data)
    body = str(data)
    if hasattr(body, 'encode'):
        raw = body.encode('utf-8')
    else:
        raw = body

    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen

        req = Request(URL, data=raw)
        req.add_header('Content-Type', 'text/plain; charset=utf-8')
        resp = urlopen(req, timeout=10)
        print('http code:', resp.getcode())
        print('http headers:', resp.info())
        content = resp.read()
        if hasattr(content, 'decode'):
            content = content.decode('utf-8', 'replace')
        print('http body:', content)
    except Exception as e:
        print('send error:', type(e).__name__, e)
