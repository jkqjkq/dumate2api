#!/usr/bin/env python3
"""Dumate-routed PPTX-to-image client used by ``thumbnail.py``.

The complete direct service URL is passed through ``get_proxy_parmas`` so the
same code works through the Dumate web gateway, desktop scheduler, or the
method's original direct fallback.
"""
from __future__ import annotations
import base64
import errno
import io
import json
import os
import random
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from PIL import Image, UnidentifiedImageError
from proxy_utils import get_proxy_parmas
CONVERT_PATH = '/xmind/convert-to-image'
DIRECT_SERVICE_URL = 'http://1.48.28.111'
DIRECT_CONVERT_URL = DIRECT_SERVICE_URL + CONVERT_PATH
# 审计修复（P0-2）：DIRECT_SERVICE_URL 是裸 IP，且整条直连链路是明文 HTTP——
# convert_pptx_to_images 会把整份用户 PPTX base64 后 POST 出网。默认禁用直连：
#   未配置 DUMATE_SESSION_ID（无代理路由）→ CloudRenderError（fallback_allowed=True），
#   thumbnail.py 据此自动走本地渲染兜底；
#   DUMATE_ALLOW_REMOTE_CONVERT=1 → 显式恢复直连（仍打 WARN 留痕）；
#   DUMATE_ALLOW_REMOTE_CONVERT=0 → 连代理路由也一并禁用（显式全关）。
REMOTE_CONVERT_ENV = 'DUMATE_ALLOW_REMOTE_CONVERT'
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_REQUEST_TIMEOUT = 180.0
DEFAULT_TOTAL_TIMEOUT = 600.0
DEFAULT_TIMEOUT_ATTEMPTS = 3
BACKOFF_SECONDS = (2.0, 5.0, 10.0, 20.0)
TRANSIENT_HTTP_STATUS = {429, 500, 502, 503, 504}
TRANSIENT_BUSINESS_CODES = {282130, 282131}
NO_LOCAL_FALLBACK_CODES = {282046}
CLIENT_PARAMETER_ERRORS = {'invalid log_id', 'invalid file_name', 'invalid save_dir', 'save_dir must be the source object key, not a directory', 'invalid BOS source path', 'invalid BOS object key', 'BOS bucket does not match deployment', 'unsupported image format', 'page index must be an integer', 'page index out of range'}

class CloudRenderError(RuntimeError):
    """Cloud request or response error with fallback eligibility."""

    def __init__(self, message: str, *, code: int | None=None, http_status: int | None=None, fallback_allowed: bool=False, retryable: bool=False, retry_after: str | None=None) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.fallback_allowed = fallback_allowed
        self.retryable = retryable
        self.retry_after = retry_after

@dataclass(frozen=True)
class CloudRenderConfig:
    endpoint: str
    max_attempts: int
    request_timeout: float
    total_timeout: float
    timeout_attempts: int
    proxy_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_environment(cls) -> 'CloudRenderConfig':
        endpoint, proxy_headers = get_proxy_parmas(DIRECT_CONVERT_URL)
        if not endpoint:
            raise CloudRenderError('DUMATE_GATEWAY_URL is required when DUMATE_SANDBOX_MODE=server and DUMATE_SESSION_ID is configured', fallback_allowed=False)
        gate = os.environ.get(REMOTE_CONVERT_ENV, '').strip().lower()
        if gate == '0':
            raise CloudRenderError('云端转图已被 DUMATE_ALLOW_REMOTE_CONVERT=0 显式禁用；云端失败时请改用本地渲染兜底', fallback_allowed=True)
        if endpoint == DIRECT_CONVERT_URL and gate != '1':
            raise CloudRenderError(
                '直连云端转图默认禁用：未配置 DUMATE_SESSION_ID 时会把整份 PPTX base64 后经明文 HTTP POST 到 '
                + DIRECT_SERVICE_URL + '（裸 IP、无 TLS）。确认需要请设 DUMATE_ALLOW_REMOTE_CONVERT=1 显式开启，'
                '或配置 DUMATE_SESSION_ID 走官方代理；本地渲染兜底不受影响',
                fallback_allowed=True)
        if endpoint == DIRECT_CONVERT_URL:
            print('警告：直连云端转图已显式启用（DUMATE_ALLOW_REMOTE_CONVERT=1）：文档内容将明文发往 ' + DIRECT_SERVICE_URL, file=sys.stderr)
        endpoint = _validate_endpoint(endpoint)
        return cls(endpoint=endpoint, max_attempts=_env_int('PPTX_CLOUD_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1, 10), request_timeout=_env_float('PPTX_CLOUD_TIMEOUT', DEFAULT_REQUEST_TIMEOUT, 1.0, 1800.0), total_timeout=_env_float('PPTX_CLOUD_TOTAL_TIMEOUT', DEFAULT_TOTAL_TIMEOUT, 1.0, 3600.0), timeout_attempts=_env_int('PPTX_CLOUD_TIMEOUT_ATTEMPTS', DEFAULT_TIMEOUT_ATTEMPTS, 1, 10), proxy_headers=proxy_headers)

def _validate_endpoint(endpoint: str) -> str:
    """Reject malformed runtime routes before constructing an HTTP request."""
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.fragment:
        raise CloudRenderError(f'cloud route must be an absolute http/https URL: {endpoint}', fallback_allowed=False)
    return endpoint

def convert_pptx_to_images(pptx_path: Path, output_dir: Path, dpi: int, expected_page_count: int, config: CloudRenderConfig | None=None) -> list[Path]:
    """Render every PPTX page to JPEG and return paths in presentation order."""
    if dpi < 72:
        raise ValueError('dpi must be at least 72')
    if expected_page_count < 1:
        raise CloudRenderError('PPTX contains no slides', fallback_allowed=False)
    config = config or CloudRenderConfig.from_environment()
    payload = {'log_id': _log_id(), 'file_name': pptx_path.name, 'file_data': base64.b64encode(pptx_path.read_bytes()).decode('ascii'), 'image_format': 'jpeg', 'dpi': dpi}
    response = _post_with_retries(config, payload)
    return decode_response(response, output_dir, expected_page_count)

def decode_response(response: dict, output_dir: Path, expected_page_count: int) -> list[Path]:
    """Validate a successful service response and materialize its JPEG pages."""
    pages = response.get('pages')
    page_count = response.get('page_count')
    if not isinstance(pages, list) or not isinstance(page_count, int):
        raise CloudRenderError('cloud response misses page_count/pages', fallback_allowed=True)
    if page_count != len(pages) or page_count != expected_page_count:
        raise CloudRenderError(f'cloud page count mismatch: expected {expected_page_count}, page_count={page_count}, pages={len(pages)}', fallback_allowed=True)
    indices = [page.get('page_index') for page in pages if isinstance(page, dict)]
    if len(indices) != len(pages) or indices != list(range(expected_page_count)):
        raise CloudRenderError(f'cloud page indices are not continuous presentation order: {indices}', fallback_allowed=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    width = len(str(expected_page_count))
    outputs: list[Path] = []
    for page in pages:
        image_format = str(page.get('image_format', '')).lower()
        if image_format not in ('jpeg', 'jpg'):
            raise CloudRenderError(f"cloud returned unsupported image format: {image_format or '<empty>'}", fallback_allowed=True)
        if not _positive_int(page.get('width')) or not _positive_int(page.get('height')):
            raise CloudRenderError('cloud returned invalid image dimensions', fallback_allowed=True)
        encoded = page.get('data')
        if not isinstance(encoded, str) or not encoded:
            raise CloudRenderError('cloud base64 mode returned no page data', fallback_allowed=True)
        try:
            image_bytes = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise CloudRenderError(f'cloud returned invalid image base64: {exc}', fallback_allowed=True) from exc
        if not image_bytes.startswith(b'\xff\xd8\xff'):
            raise CloudRenderError('cloud page is not a JPEG', fallback_allowed=True)
        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                actual_format = image.format
                actual_size = image.size
                image.verify()
        except (UnidentifiedImageError, OSError, SyntaxError) as exc:
            raise CloudRenderError(f'cloud returned an unreadable JPEG: {exc}', fallback_allowed=True) from exc
        if actual_format != 'JPEG':
            raise CloudRenderError(f'cloud image payload format is {actual_format}, not JPEG', fallback_allowed=True)
        declared_dimensions = (page['width'], page['height'])
        if actual_size != declared_dimensions:
            raise CloudRenderError(f'cloud image dimensions mismatch: declared {declared_dimensions}, decoded {actual_size}', fallback_allowed=True)
        declared_size = page.get('size_bytes')
        if isinstance(declared_size, int) and declared_size != len(image_bytes):
            raise CloudRenderError(f'cloud image size mismatch: declared {declared_size}, decoded {len(image_bytes)}', fallback_allowed=True)
        image_path = output_dir / f"slide-{page['page_index'] + 1:0{width}d}.jpg"
        image_path.write_bytes(image_bytes)
        outputs.append(image_path)
    return outputs

def _post_with_retries(config: CloudRenderConfig, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    deadline = time.monotonic() + config.total_timeout
    timeout_failures = 0
    last_error: CloudRenderError | None = None
    for attempt in range(1, config.max_attempts + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        timeout = min(config.request_timeout, remaining)
        try:
            response = _post_once(config.endpoint, body, timeout, config.proxy_headers)
        except CloudRenderError as exc:
            last_error = exc
            if exc.code in TRANSIENT_BUSINESS_CODES:
                timeout_failures += 1
                can_retry = exc.retryable and timeout_failures < config.timeout_attempts
            else:
                can_retry = exc.retryable
            if not can_retry or attempt >= config.max_attempts:
                raise
            _wait_before_retry(attempt, deadline, exc.retry_after)
            continue
        code = _error_code(response)
        if code == 0:
            return response
        message = response.get('error_msg') or response.get('error_message') or 'unknown error'
        error = _business_error(code, str(message))
        last_error = error
        if error.retryable:
            if code in TRANSIENT_BUSINESS_CODES:
                timeout_failures += 1
                within_type_budget = timeout_failures < config.timeout_attempts
            else:
                within_type_budget = True
            if within_type_budget and attempt < config.max_attempts:
                _wait_before_retry(attempt, deadline, None)
                continue
        raise error
    if last_error is not None:
        raise CloudRenderError(f'cloud retry budget exhausted: {last_error}', code=last_error.code, http_status=last_error.http_status, fallback_allowed=last_error.fallback_allowed, retryable=False) from last_error
    raise CloudRenderError('cloud total timeout exhausted', fallback_allowed=True)

def _post_once(endpoint: str, body: bytes, timeout: float, proxy_headers: dict[str, str] | None=None) -> dict:
    request = urllib.request.Request(endpoint, data=body, headers=_headers(proxy_headers), method='POST')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
        if status in TRANSIENT_HTTP_STATUS or status >= 500:
            retry_after = exc.headers.get('Retry-After') if exc.headers else None
            error = CloudRenderError(f'cloud HTTP {status}', http_status=status, fallback_allowed=True, retryable=True, retry_after=retry_after)
            raise error from exc
        detail = raw.decode('utf-8', 'replace')[:500]
        raise CloudRenderError(f'cloud HTTP {status}: {detail}', http_status=status, fallback_allowed=status != 400, retryable=status == 408) from exc
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        permission_blocked = _network_permission_blocked(exc)
        raise CloudRenderError(f'cloud request failed: {exc}', fallback_allowed=True, retryable=not permission_blocked) from exc
    try:
        parsed = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CloudRenderError(f'cloud response is not valid JSON: {exc}', fallback_allowed=True, retryable=True) from exc
    if not isinstance(parsed, dict):
        raise CloudRenderError('cloud response is not a JSON object', fallback_allowed=True, retryable=True)
    return parsed

def _headers(proxy_headers: dict[str, str] | None=None) -> dict[str, str]:
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json', 'Connection': 'close'}
    if proxy_headers:
        headers.update(proxy_headers)
    return headers

def _wait_before_retry(attempt: int, deadline: float, retry_after: str | None) -> None:
    delay = 0.0
    if retry_after:
        try:
            delay = max(0.0, float(retry_after))
        except ValueError:
            delay = 0.0
    if delay <= 0:
        delay = BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)]
        delay += random.uniform(0.0, 0.5)
    delay = min(delay, max(0.0, deadline - time.monotonic()))
    if delay > 0:
        print(f'Cloud render retry {attempt}: waiting {delay:.1f}s', file=sys.stderr)
        time.sleep(delay)

def _business_error(code: int | None, message: str) -> CloudRenderError:
    normalized = message.strip()
    retryable = code in TRANSIENT_BUSINESS_CODES or (code == -1 and normalized == 'internal_error')
    fallback_allowed = code not in NO_LOCAL_FALLBACK_CODES
    if code == -1 and any((normalized.startswith(message) for message in CLIENT_PARAMETER_ERRORS)):
        fallback_allowed = False
    return CloudRenderError(f"cloud conversion failed ({code}): {normalized or 'unknown error'}", code=code, fallback_allowed=fallback_allowed, retryable=retryable)

def _error_code(response: dict) -> int | None:
    value = response.get('error_code')
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def _network_permission_blocked(exc: BaseException) -> bool:
    candidate = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    return isinstance(candidate, OSError) and candidate.errno in (errno.EACCES, errno.EPERM)

def _positive_int(value: object) -> bool:
    return isinstance(value, int) and (not isinstance(value, bool)) and (value > 0)

def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    try:
        value = int(raw) if raw is not None else default
    except ValueError as exc:
        raise CloudRenderError(f'{name} must be an integer', fallback_allowed=False) from exc
    if not minimum <= value <= maximum:
        raise CloudRenderError(f'{name} must be between {minimum} and {maximum}', fallback_allowed=False)
    return value

def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None else default
    except ValueError as exc:
        raise CloudRenderError(f'{name} must be numeric', fallback_allowed=False) from exc
    if not minimum <= value <= maximum:
        raise CloudRenderError(f'{name} must be between {minimum:g} and {maximum:g}', fallback_allowed=False)
    return value

def _log_id() -> str:
    request_id = os.environ.get('DUMATE_REQUEST_ID', '').strip()
    if request_id:
        sanitized = re.sub('[^A-Za-z0-9_-]+', '-', request_id).strip('-')
        if sanitized:
            return sanitized[:128]
    return f'pptx-render-{int(time.time() * 1000)}'