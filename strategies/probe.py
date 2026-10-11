# Sandbox 穿透测试脚本，丢进QMT的handle_bar或init中执行
import os, sys, tempfile, ctypes
from ctypes import wintypes

results = {}

# 1. 文件IO
try:
    with tempfile.NamedTemporaryFile(mode='w', delete=True) as f:
        f.write('test')
    results['open_write'] = 'PASS'
except: results['open_write'] = 'FAIL'

try:
    fp = os.path.join(tempfile.gettempdir(), 'qmt_test.txt')
    open(fp, 'r')
    results['open_read'] = 'PASS'
except: results['open_read'] = 'FAIL'

# 2. Socket
try:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    s.connect(('104.21.16.189', 443))
    s.close()
    results['socket'] = 'PASS'
except: results['socket'] = 'FAIL'

# 3. Subprocess
try:
    import subprocess
    subprocess.run(['echo', 'test'], capture_output=True, timeout=2)
    results['subprocess'] = 'PASS'
except: results['subprocess'] = 'FAIL'

# 4. ctypes (关键！)
try:
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    handle = kernel32.CreateFileW(
        r'\\.\pipe\test_sandbox_pipe', 0x80000000, 0, None, 3, 0, None
    )
    kernel32.CloseHandle(handle)
    results['ctypes_pipe'] = 'PASS'
except: results['ctypes_pipe'] = 'FAIL'

# 5. SQLite
try:
    import sqlite3
    conn = sqlite3.connect(os.path.join(tempfile.gettempdir(), 'sandbox_test.db'))
    conn.execute('CREATE TABLE IF NOT EXISTS test (id INTEGER)')
    conn.execute('INSERT INTO test VALUES (1)')
    conn.commit()
    conn.close()
    results['sqlite3'] = 'PASS'
except: results['sqlite3'] = 'FAIL'

# 6. os.environ
try:
    os.environ['QMT_SANDBOX_TEST'] = '1'
    val = os.environ.get('QMT_SANDBOX_TEST')
    results['environ_write'] = 'PASS' if val == '1' else 'FAIL_READ_ONLY'
except: results['environ_write'] = 'FAIL'

# 7. threading
try:
    import threading
    t = threading.Thread(target=lambda: None)
    t.start()
    t.join()
    results['threading'] = 'PASS'
except: results['threading'] = 'FAIL'

# 打印结果
print('\n' + '='*50)
print('QMT Sandbox Penetration Test Results')
print('='*50)
for k, v in results.items():
    status = '✅' if v == 'PASS' else '❌'
    print(f'  {status} {k}: {v}')
print('='*50)

# 根据结果推荐方案
if results.get('ctypes_pipe') == 'PASS':
    print('\n Best Solution: name pipe + shared memory (ctypes ok)')
elif results.get('sqlite3') == 'PASS':
    print('\n Best Solution: SQLite DB (ctypes not ok, sqlite ok)')
else:
    print('\n Best Solution: external signal inject')
