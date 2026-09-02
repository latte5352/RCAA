from flask import Flask, request, jsonify, session
import requests
from requests.auth import HTTPBasicAuth

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = "dev-only-secret-change-me"  # 데모 전용 값. 운영 배포 시에는 반드시 환경변수 등으로 교체해야 함

BASE_URL = "https://codebeamer.slworld.com/cb/rest"


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return jsonify({"ok": False, "error": "아이디/비밀번호를 입력해주세요."}), 400

    try:
        resp = requests.get(
            f"{BASE_URL}/projects/page/1",
            auth=HTTPBasicAuth(username, password),
            timeout=10,
        )
    except requests.exceptions.RequestException as e:
        return jsonify({"ok": False, "error": f"코드비머 서버에 접속할 수 없습니다: {e}"}), 502

    if resp.status_code == 200:
        # 데모 전용: 세션에 비밀번호를 그대로 담아둠.
        # 실제 배포판에서는 이 자리를 SSO 토큰/개인 Access Token 발급 흐름으로 교체해야 함 (이전 논의 참고)
        session["username"] = username
        session["password"] = password
        return jsonify({"ok": True, "username": username})
    elif resp.status_code == 401:
        return jsonify({"ok": False, "error": "아이디 또는 비밀번호가 올바르지 않습니다."}), 401
    else:
        return jsonify({"ok": False, "error": f"로그인 확인 중 오류 (상태 코드: {resp.status_code})"}), 502


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/projects", methods=["GET"])
def projects():
    username = session.get("username")
    password = session.get("password")
    if not username:
        return jsonify({"ok": False, "error": "로그인이 필요합니다."}), 401

    try:
        resp = requests.get(
            f"{BASE_URL}/projects/page/1",
            auth=HTTPBasicAuth(username, password),
            timeout=15,
        )
    except requests.exceptions.RequestException as e:
        return jsonify({"ok": False, "error": f"코드비머 서버에 접속할 수 없습니다: {e}"}), 502

    if resp.status_code != 200:
        return jsonify({"ok": False, "error": f"프로젝트 목록 조회 실패 (상태 코드: {resp.status_code})"}), 502

    data = resp.json()
    project_list = [
        {"id": p.get("id"), "name": p.get("name"), "uri": p.get("uri")}
        for p in data.get("projects", [])
    ]
    return jsonify({"ok": True, "projects": project_list})


@app.route("/api/start-audit", methods=["POST"])
def start_audit():
    # 컨셉 리뷰용 더미 엔드포인트: 실제 형상 감사 로직(A~E 파이프라인)은 아직 연결하지 않음
    data = request.get_json(force=True) or {}
    project_name = data.get("project_name", "선택된 프로젝트")
    return jsonify({
        "ok": True,
        "message": f"[데모] '{project_name}' 프로젝트에 대한 주기적 형상 감사를 시작합니다. (실제 감사 로직은 컨셉 리뷰 이후 연결 예정)"
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)
