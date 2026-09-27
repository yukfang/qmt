#coding:gbk
"""
从 Web 拉取 UI 发起的买挂/卖挂，并在实盘执行。

必须「交易」里实盘启动，不要回测。
与 qmt_order_status.py 可同时运行：订单状态推送与订单执行并行，互不干扰。

流程：
  GET  /api/commands
  POST /api/commands/{id}/claim
  action=hang -> passorder 限价买/卖
  action=cancel 或有 targetOrderId -> cancel 撤单（绝不再下单）
  POST /api/commands/{id}/result
"""
TOKEN = ''
ACCOUNT = '220500068710'
STOCKS = ['159781.SZ', '516310.SH']
STOCK_UNIVERSE = STOCKS[0]
BASE_URL = 'https://qmt-console.enrichlife.today'
POLL_SEC = 2
STRATEGY_NAME = 'qmt_hang_exec'


def _now():
    import time
    return time.time()


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=True, default=str)


def _http_json(path, payload=None, method='GET'):
    body = None
    if payload is not None:
        raw = _json_dumps(payload)
        body = raw.encode('utf-8') if hasattr(raw, 'encode') else raw
    try:
        try:
            from urllib.request import Request, urlopen
        except ImportError:
            from urllib2 import Request, urlopen
        url = BASE_URL.rstrip('/') + path
        req = Request(url, data=body)
        req.add_header('User-Agent', 'QMT-Bridge/1.0')
        if method != 'POST' and body is None:
            try:
                req.get_method = lambda: method
            except Exception:
                pass
        if method == 'POST' or body is not None:
            req.add_header('Content-Type', 'application/json')
            try:
                req.get_method = lambda: 'POST'
            except Exception:
                pass
        if TOKEN:
            req.add_header('X-Bridge-Token', TOKEN)
        resp = urlopen(req, timeout=8)
        content = resp.read()
        if hasattr(content, 'decode'):
            content = content.decode('utf-8', 'replace')
        return resp.getcode(), content
    except Exception as e:
        return _http_error(e)


def _http_error(e):
    code = getattr(e, 'code', None)
    if code is None or not hasattr(e, 'read'):
        return -1, '%s %s' % (type(e).__name__, e)
    try:
        content = e.read()
        if hasattr(content, 'decode'):
            content = content.decode('utf-8', 'replace')
    except Exception:
        content = ''
    headers = getattr(e, 'headers', None) or getattr(e, 'hdrs', None)
    reason = ''
    server = ''
    if headers is not None:
        try:
            reason = headers.get('X-QMT-Reason') or ''
            server = headers.get('Server') or ''
        except Exception:
            pass
    return int(code), 'server=%s reason=%s body=%s' % (server, reason, str(content)[:400])


def _parse_json(content):
    import json
    try:
        return json.loads(content)
    except Exception:
        return None


LOG_SOURCE = 'exec'
LOG_KEEP = 2000
LOG_BATCH = 500
_LOG_BUF = []
_LOG_STATE = {'run_id': '', 'dropped': 0, 'beat': 0}


def _log_ts():
    import time
    t = time.time()
    off = -time.altzone if time.localtime(t).tm_isdst > 0 else -time.timezone
    sign = '+' if off >= 0 else '-'
    off = abs(off)
    return '%s.%03d%s%02d:%02d' % (
        time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(t)), int((t % 1) * 1000),
        sign, off // 3600, (off % 3600) // 60)


def _new_run_id():
    import random
    import time
    _LOG_STATE['run_id'] = '%s-%04x' % (time.strftime('%m%d%H%M%S'), random.randint(0, 0xffff))
    return _LOG_STATE['run_id']


def _debug(ContextInfo, message, level='info'):
    print(message)
    _LOG_BUF.append({'ts': _log_ts(), 'level': level, 'message': str(message)})
    if len(_LOG_BUF) > LOG_KEEP:
        extra = len(_LOG_BUF) - LOG_KEEP
        del _LOG_BUF[:extra]
        _LOG_STATE['dropped'] += extra


def _log_exc(ContextInfo, where):
    import traceback
    _debug(ContextInfo, '%s exception\n%s' % (where, traceback.format_exc()), 'error')


def _flush_debug(ContextInfo):
    while _LOG_BUF:
        if _LOG_STATE['dropped']:
            _LOG_BUF.insert(0, {'ts': _log_ts(), 'level': 'warn',
                                'message': 'log buffer overflow, dropped %s lines' % _LOG_STATE['dropped']})
            _LOG_STATE['dropped'] = 0
        batch = _LOG_BUF[:LOG_BATCH]
        code, content = _http_json('/api/logs', {
            'source': LOG_SOURCE, 'runId': _LOG_STATE['run_id'], 'lines': batch}, method='POST')
        if code != 200:
            print('log upload failed http=%s keep=%s %s' % (code, len(_LOG_BUF), str(content)[:300]))
            return
        del _LOG_BUF[:len(batch)]


def _resolve_fn(ContextInfo, names):
    try:
        import builtins as bi
    except ImportError:
        import __builtin__ as bi
    for n in names:
        for obj in (bi, globals(), ContextInfo):
            fn = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
            if callable(fn):
                return n, fn
    return None, None


def _resolve_passorder(ContextInfo):
    return _resolve_fn(ContextInfo, ('passorder', 'order_shares'))


def _place_limit(ContextInfo, side, stock, price, qty, account):
    """
    迅投/银河常见限价：
      buy  passorder(23, 1101, account, stock, 11, price, qty, name, 2, ContextInfo)
      sell passorder(24, 1101, account, stock, 11, price, qty, name, 2, ContextInfo)
    若签名不同，日志会打出异常，再按券商文档改。
    """
    name, fn = _resolve_passorder(ContextInfo)
    if not fn:
        return False, 'passorder not found'

    op = 23 if side == 'buy' else 24
    try:
        if name == 'passorder':
            # opType, orderType, accountid, orderCode, prType, price, volume, strategyName, quickTrade, ContextInfo
            ret = fn(op, 1101, account, stock, 11, float(price), int(qty), STRATEGY_NAME, 2, ContextInfo)
            return True, str(ret)
        # order_shares(stockcode, amount, style, price, ContextInfo, accountid)
        # amount>0 buy, <0 sell; style often LimitOrderStyle(price)
        amount = int(qty) if side == 'buy' else -int(qty)
        try:
            style = LimitOrderStyle(float(price))  # noqa: F821
        except Exception:
            style = float(price)
        ret = fn(stock, amount, style, float(price), ContextInfo, account)
        return True, str(ret)
    except Exception as e:
        return False, '%s %s' % (type(e).__name__, e)


def _cancel_order(ContextInfo, order_id, stock, account):
    """
    迅投/银河撤单。只调用撤单接口，绝不走 passorder 下单。
    常见：cancel(orderId, accountid, 'STOCK', ContextInfo)
    """
    oid = str(order_id or '').strip()
    if not oid:
        return False, 'empty targetOrderId'

    name, fn = _resolve_fn(ContextInfo, ('cancel', 'cancel_order', 'cancelorder'))
    if not fn:
        return False, 'cancel not found'

    # 按从最常见到次常见尝试；任一成功即停。失败不改走下单。
    tries = [
        (oid, account, 'STOCK', ContextInfo),
        (oid, account, 'stock', ContextInfo),
        (oid, account, ContextInfo),
        (account, oid, ContextInfo),
        (oid, ContextInfo),
    ]
    last = 'cancel failed'
    for args in tries:
        try:
            ret = fn(*args)
            return True, str(ret)
        except TypeError as e:
            last = 'TypeError %s' % e
            continue
        except Exception as e:
            last = '%s %s' % (type(e).__name__, e)
            # 参数个数不对继续试；其它错误也继续试下一签名
            continue
    return False, last


def _is_cancel_cmd(cmd, claimed):
    """有 targetOrderId、action=cancel，或 stock 含 |C| 标记，一律视为撤单。"""
    srcs = (claimed or {}, cmd or {})
    action = ''
    target = ''
    stock = ''
    for src in srcs:
        if not action:
            action = str(src.get('action') or '').strip().lower()
        if not target:
            target = str(src.get('targetOrderId') or src.get('target_order_id') or '').strip()
        if not stock:
            stock = str(src.get('stock') or '').strip()
    if '|C|' in stock:
        parts = stock.split('|C|')
        stock_code = (parts[0] or '').strip()
        oid = (parts[1] if len(parts) > 1 else '').strip()
        return True, oid or target, stock_code
    if action == 'cancel' or target:
        return True, target, stock
    return False, '', stock


def _fetch_commands():
    code, content = _http_json('/api/commands?limit=10', method='GET')
    data = _parse_json(content)
    if code != 200 or not data or not data.get('ok'):
        return [], 'GET /api/commands http=%s body=%s' % (code, str(content)[:500])
    return data.get('commands') or [], None


def _claim(cmd_id):
    code, content = _http_json('/api/commands/%s/claim' % cmd_id, {}, method='POST')
    data = _parse_json(content)
    if code != 200 or not data or not data.get('ok'):
        return None, 'claim http=%s body=%s' % (code, str(content)[:500])
    return data.get('command'), None


def _result(cmd_id, ok, broker_order_id='', error=''):
    payload = {'ok': bool(ok), 'brokerOrderId': broker_order_id or '', 'error': error or ''}
    code, content = _http_json('/api/commands/%s/result' % cmd_id, payload, method='POST')
    return code, content


def hang_poll(ContextInfo):
    try:
        _run_once(ContextInfo)
    except Exception:
        _log_exc(ContextInfo, 'hang_poll')
        _flush_debug(ContextInfo)


def _try_start_run_time(ContextInfo):
    if not hasattr(ContextInfo, 'run_time'):
        return False
    period = '%dnSecond' % int(POLL_SEC)
    try:
        ContextInfo.run_time('hang_poll', period, '2020-01-01 09:30:00')
        _debug(ContextInfo, 'run_time ok period=%s' % period)
        return True
    except Exception as e:
        _debug(ContextInfo, 'run_time failed: %s %s' % (type(e).__name__, e), 'error')
        return False


def _poll_loop(ContextInfo):
    import time
    while not getattr(ContextInfo, 'stop_poll', False):
        try:
            _run_once(ContextInfo)
        except Exception:
            _log_exc(ContextInfo, 'poll_loop')
            _flush_debug(ContextInfo)
        time.sleep(POLL_SEC)


def _run_once(ContextInfo):
    if not BASE_URL or not ACCOUNT:
        _debug(ContextInfo, '请填写 BASE_URL 和 ACCOUNT', 'error')
        _flush_debug(ContextInfo)
        return

    cmds, err = _fetch_commands()
    if err:
        _debug(ContextInfo, err, 'error')
        _flush_debug(ContextInfo)
        return
    if not cmds:
        now = _now()
        if now - _LOG_STATE['beat'] >= 60:
            _LOG_STATE['beat'] = now
            _debug(ContextInfo, 'idle: no pending commands')
            _flush_debug(ContextInfo)
        return

    for cmd in cmds:
        cid = cmd.get('id')
        claimed, cerr = _claim(cid)
        if cerr or not claimed:
            _debug(ContextInfo, 'skip %s: %s' % (cid, cerr or 'empty'), 'error')
            continue
        side = str(claimed.get('side') or cmd.get('side') or '')
        account = str(claimed.get('account') or cmd.get('account') or ACCOUNT)
        is_cancel, target, stock_from_token = _is_cancel_cmd(cmd, claimed)
        stock = stock_from_token or str(claimed.get('stock') or cmd.get('stock') or STOCK_UNIVERSE)
        if '|C|' in stock:
            stock = stock.split('|C|')[0] or STOCK_UNIVERSE
        price = claimed.get('price') if claimed.get('price') is not None else cmd.get('price')
        qty = claimed.get('qty') if claimed.get('qty') is not None else cmd.get('qty')
        if is_cancel:
            if not target:
                _result(cid, False, error='cancel missing targetOrderId')
                _debug(ContextInfo, 'fail id=%s cancel missing targetOrderId' % cid, 'error')
                continue
            _debug(ContextInfo, 'cancel id=%s order=%s %s (never place)' % (cid, target, stock))
            ok, detail = _cancel_order(ContextInfo, target, stock, account)
        else:
            _debug(ContextInfo, 'hang id=%s %s %s @%s x%s' % (cid, side, stock, price, qty))
            ok, detail = _place_limit(ContextInfo, side, stock, price, qty, account)
        if ok:
            _result(cid, True, broker_order_id=str(detail)[:64], error='')
            _debug(ContextInfo, 'done id=%s ret=%s' % (cid, str(detail)[:120]))
        else:
            _result(cid, False, error=str(detail)[:500])
            _debug(ContextInfo, 'fail id=%s %s' % (cid, detail), 'error')
    _flush_debug(ContextInfo)


def init(ContextInfo):
    ContextInfo.stop_poll = False
    _new_run_id()
    ContextInfo.set_universe(STOCKS)
    if ACCOUNT and hasattr(ContextInfo, 'set_account'):
        try:
            ContextInfo.set_account(ACCOUNT)
            _debug(ContextInfo, 'set_account ok')
        except Exception as e:
            _debug(ContextInfo, 'set_account error: %s' % e, 'error')
    _debug(ContextInfo, 'hang executor init %s -> %s poll=%ss' % (','.join(STOCKS), BASE_URL, POLL_SEC))

    if _try_start_run_time(ContextInfo):
        _run_once(ContextInfo)
        _flush_debug(ContextInfo)
        return

    _debug(ContextInfo, 'fallback blocking poll loop')
    _flush_debug(ContextInfo)
    _poll_loop(ContextInfo)


def handlebar(ContextInfo):
    return
