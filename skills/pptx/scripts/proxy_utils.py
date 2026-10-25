"""Dumate web/desktop proxy routing shared by the PPTX cloud client."""
from __future__ import annotations
import os
from typing import Dict, Tuple
from urllib.parse import urlparse

def get_proxy_parmas(original_url: str) -> Tuple[str, Dict[str, str]]:
    """把原始服务 URL 转成桌面端/web 端代理 URL 并附加鉴权请求头。

    保持 Dumate 技能的既有代理语义：未配置 ``DUMATE_SESSION_ID`` 时
    原样返回；web 端使用 gateway，桌面端使用 scheduler 代理。
    """
    session_id = os.environ.get('DUMATE_SESSION_ID')
    if not session_id:
        return (original_url, {})
    sandbox_mode = os.environ.get('DUMATE_SANDBOX_MODE')
    url = original_url
    parsed = urlparse(original_url)
    extra_headers = {'X-Dumate-Session-Id': session_id}
    request_id = os.environ.get('DUMATE_REQUEST_ID', '')
    if request_id:
        extra_headers['X-Dumate-Request-Id'] = request_id
    if sandbox_mode and sandbox_mode == 'server':
        gateway_url = os.environ.get('DUMATE_GATEWAY_URL')
        if not gateway_url:
            return ('', {})
        url = gateway_url.rstrip('/') + parsed.path
        dtoken = os.environ.get('DUMATE_DTOKEN')
        if dtoken:
            extra_headers['Authorization'] = f'Bearer {dtoken}'
    else:
        scheduler_url = os.environ.get('DUMATE_SCHEDULER_URL')
        if not scheduler_url:
            return (original_url, {})
        url = f'{scheduler_url}/api/qianfanproxy{parsed.path}'
    if parsed.query:
        url += f'?{parsed.query}'
    return (url, extra_headers)
