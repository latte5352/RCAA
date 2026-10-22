"""SUP.8 형상감사 - 부서 공용 저장소 서버.

예전엔 익스텐션이 history_snapshot/applied_snapshot/periodic_ng_snapshot/review_state를
chrome.storage.local(그 브라우저 안에만 있음)에 저장해서, 같은 프로젝트를 다른 사람이
감사하면 "지난 감사" 기준이 사람마다 다르게 보이는 한계가 있었다. 이 서버는 그 값들을
팀 전체가 같이 보는 공용 저장소로 옮겨주는 아주 단순한 key-value 저장소일 뿐이다.

codebeamer 통신 자체는 여전히 각자 브라우저가 자기 계정으로 직접 한다 - 이 서버는 codebeamer와
전혀 통신하지 않고, 익스텐션이 이미 계산한 결과만 저장/조회한다(그래서 이 서버엔 codebeamer
자격증명이 필요 없다).

외부 의존성 없이 파이썬 표준 라이브러리만 쓴다 - 배포할 서버에 어떤 패키지가 깔려있을지
몰라서, pip install 없이 바로 `python app.py`로 띄울 수 있게 하기 위함이다.

실행: python app.py [포트, 기본 8787]
"""

import datetime
import json
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

DB_PATH = Path(__file__).parent / "data.sqlite3"

# 이 네 개만 저장 대상으로 허용한다(lib/history.js, lib/reviewState.js가 쓰는 것과 1:1 대응) -
# 익스텐션 쪽에서 실수로 엉뚱한 키를 보내도 조용히 저장되지 않고 404로 막히게 하기 위함.
ALLOWED_KEYS = {"history_snapshot", "applied_snapshot", "periodic_ng_snapshot", "review_state"}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kv_store (
            project TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project, key)
        )
        """
    )
    return conn


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 익스텐션(chrome-extension://...)에서 바로 호출하므로 CORS를 열어둬야 한다.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _parse_kv_path(self):
        # /api/kv/{project}/{key}
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/")]
        if len(parts) != 4 or parts[0] != "api" or parts[1] != "kv":
            return None, None
        _, _, project, key = parts
        return project, key

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            return self._send_json(200, {"ok": True})

        project, key = self._parse_kv_path()
        if not project or key not in ALLOWED_KEYS:
            return self._send_json(404, {"error": "not found"})

        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM kv_store WHERE project = ? AND key = ?", (project, key)
            ).fetchone()
        finally:
            conn.close()
        value = json.loads(row[0]) if row else None
        self._send_json(200, {"value": value})

    def do_PUT(self):
        project, key = self._parse_kv_path()
        if not project or key not in ALLOWED_KEYS:
            return self._send_json(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "invalid json"})
        if "value" not in body:
            return self._send_json(400, {"error": "'value' field required"})

        conn = get_db()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO kv_store (project, key, value, updated_at) VALUES (?, ?, ?, ?)",
                (project, key, json.dumps(body["value"]), datetime.datetime.utcnow().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        self._send_json(200, {"ok": True})

    def log_message(self, format, *args):  # noqa: A002 - BaseHTTPRequestHandler 시그니처 그대로 따름
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"SUP.8 공용 저장소 서버 실행 중: http://0.0.0.0:{port}  (데이터 파일: {DB_PATH})")
    server.serve_forever()


if __name__ == "__main__":
    main()
