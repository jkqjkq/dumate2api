#!/usr/bin/env python3
"""Validate local PPTX dependencies and cloud-render configuration.

This preflight deliberately performs no network probe. LibreOffice and
PyMuPDF are optional fallback dependencies and are checked only if fallback is
actually entered by ``thumbnail.py``.
"""
from __future__ import annotations
import argparse
import importlib
import os
import platform
import sys
from urllib.parse import urlparse
from proxy_utils import get_proxy_parmas
MIN_PYTHON = (3, 10)
PYTHON_DEPENDENCIES = (('python-pptx', 'pptx'), ('lxml', 'lxml.etree'), ('Pillow', 'PIL'), ('defusedxml', 'defusedxml'))
FALLBACK_MODES = {'off', 'existing', 'install'}
CONVERT_PATH = '/xmind/convert-to-image'
DIRECT_CONVERT_URL = 'http://1.48.28.111' + CONVERT_PATH

def log(message: str) -> None:
    print(message, file=sys.stderr)

def valid_service_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in ('http', 'https') and bool(parsed.netloc) and (not parsed.fragment)

def route_label() -> str:
    if not os.environ.get('DUMATE_SESSION_ID'):
        return '直连服务（未配置 DUMATE_SESSION_ID；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）'
    if os.environ.get('DUMATE_SANDBOX_MODE') == 'server':
        return 'Dumate Web 网关'
    if os.environ.get('DUMATE_SCHEDULER_URL'):
        return 'Dumate 桌面端 scheduler 代理'
    return '直连服务（桌面端未配置 DUMATE_SCHEDULER_URL；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）'

def main() -> int:
    parser = argparse.ArgumentParser(description='检查 PPTX 技能运行环境')
    parser.add_argument('--shell', choices=('posix', 'powershell'), help='保留的兼容参数；云端主链路不再需要输出 PATH 修正命令')
    parser.parse_args()
    failures = 0
    warnings = 0
    missing_python: list[str] = []
    system = platform.system()
    log(f'PPTX 环境预检（{system} {platform.machine()}）')
    if sys.version_info >= MIN_PYTHON:
        log(f'[就绪] Python {platform.python_version()}')
    else:
        failures += 1
        log(f'[缺失] Python 需要 {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+，当前 {platform.python_version()}')
    for distribution, module in PYTHON_DEPENDENCIES:
        try:
            importlib.import_module(module)
        except ImportError as error:
            failures += 1
            missing_python.append(distribution)
            log(f'[缺失] Python 库 {distribution}：{error}')
        else:
            log(f'[就绪] Python 库 {distribution}')
    endpoint, _proxy_headers = get_proxy_parmas(DIRECT_CONVERT_URL)
    if not endpoint:
        failures += 1
        log('[错误] Web 端已配置 DUMATE_SESSION_ID，但缺少 DUMATE_GATEWAY_URL')
    elif not valid_service_url(endpoint):
        failures += 1
        log(f'[错误] 云端转图接口不是有效的 http/https 地址：{endpoint}')
    else:
        log(f'[就绪] 云端转图路由：{route_label()} → {endpoint}')
    if endpoint == DIRECT_CONVERT_URL and os.environ.get('DUMATE_ALLOW_REMOTE_CONVERT', '').strip().lower() != '1':
        log('[警告] 直连云端转图默认禁用（明文 HTTP 外传用户文档）：设 DUMATE_ALLOW_REMOTE_CONVERT=1 可显式开启；云端失败时将走本地渲染兜底')
    elif endpoint == DIRECT_CONVERT_URL:
        log('[警告] 直连云端转图已显式启用（DUMATE_ALLOW_REMOTE_CONVERT=1）：文档内容将明文发往 ' + DIRECT_CONVERT_URL)
    fallback = os.environ.get('PPTX_LOCAL_FALLBACK', 'install').strip().lower()
    if fallback not in FALLBACK_MODES:
        failures += 1
        log('[错误] PPTX_LOCAL_FALLBACK 只能是 off、existing 或 install')
    else:
        log(f'[配置] 本地兜底模式 {fallback}（仅云端失败时检查依赖）')
    if missing_python:
        extra = ' --break-system-packages' if system == 'Linux' else ''
        log('\n安装指引：')
        log(f"  Python 库：{sys.executable} -m pip install{extra} {' '.join(missing_python)}")
    log('')
    if failures:
        log(f'结果：{failures} 个失败，{warnings} 个警告；修复后重新执行此脚本。')
        return 1
    log(f'结果：0 个失败，{warnings} 个警告；环境预检通过。')
    return 0
if __name__ == '__main__':
    raise SystemExit(main())