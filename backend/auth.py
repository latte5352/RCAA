"""세션 기반 인증.

codebeamer 자격증명은 로그인 시 1회만 검증하고, 서버 메모리에 세션ID로만 참조되는
상태로 TTL 동안 보관한다. 클라이언트(브라우저 확장)에는 세션ID만 발급하며,
비밀번호는 응답에도, 로그에도 절대 남기지 않는다.
"""
import secrets
import threading
import time

import requests
from requests.auth import HTTPBasicAuth

SESSION_TTL_SECONDS = 2 * 60 * 60  # 2시간

_sessions = {}
_lock = threading.Lock()


class AuthError(Exception):
    pass


def login(base_url: str, username: str, password: str) -> str:
    resp = requests.get(
        f"{base_url}/projects/page/1",
        auth=HTTPBasicAuth(username, password),
        timeout=10,
    )
    if resp.status_code != 200:
        raise AuthError("codebeamer 로그인 실패: 계정 또는 비밀번호를 확인하세요.")

    session_id = secrets.token_urlsafe(32)
    with _lock:
        _sessions[session_id] = {
            "username": username,
            "password": password,
            "expires_at": time.time() + SESSION_TTL_SECONDS,
        }
    return session_id


def list_projects(base_url: str, username: str, password: str):
    """로그인한 계정이 접근 가능한 프로젝트 목록을 전부 페이지네이션으로 가져온다."""
    auth_ = HTTPBasicAuth(username, password)
    projects = []
    page = 1
    while page <= 50:  # 안전장치: 비정상 응답으로 무한루프에 빠지지 않도록 상한
        resp = requests.get(f"{base_url}/projects/page/{page}", auth=auth_, timeout=10)
        if resp.status_code != 200:
            break
        page_projects = resp.json().get("projects", [])
        if not page_projects:
            break
        projects.extend(page_projects)
        page += 1
    return [{"name": p.get("name"), "uri": p.get("uri")} for p in projects]


def get_credentials(session_id: str):
    with _lock:
        entry = _sessions.get(session_id)
        if entry is None:
            raise AuthError("세션이 없거나 만료되었습니다. 다시 로그인하세요.")
        if entry["expires_at"] < time.time():
            del _sessions[session_id]
            raise AuthError("세션이 만료되었습니다. 다시 로그인하세요.")
        return entry["username"], entry["password"]


def logout(session_id: str):
    with _lock:
        _sessions.pop(session_id, None)
