"""codebeamer 접속 정보 로더.

비밀번호를 코드에 직접 적지 않기 위한 공용 모듈.
프로젝트 루트에 .env 파일(.env.example 참고)을 만들어두면 여기서 읽어 환경변수로 등록하고,
없으면 이미 설정된 환경변수(OS, 백엔드 서버 등)를 그대로 사용한다.
"""
import os
from pathlib import Path


def _load_dotenv():
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

CB_USERNAME = os.environ.get("CB_USERNAME", "")
CB_PASSWORD = os.environ.get("CB_PASSWORD", "")
CB_PROJECT_NAME = os.environ.get("CB_PROJECT_NAME", "GM_9BQX_HL_LDM")
BASE_URL = os.environ.get("CB_BASE_URL", "https://codebeamer.slworld.com/cb/rest")
BASE_URL_V3 = os.environ.get("CB_BASE_URL_V3", "https://codebeamer.slworld.com/cb/api/v3")
TRACKER_NAME_CIL = os.environ.get("CB_TRACKER_CIL", "[SUP.8]Configuration Item List")
TRACKER_NAME_NCL = os.environ.get("CB_TRACKER_NCL", "[SUP.9]Non-Conformance List")


def require_credentials():
    if not CB_USERNAME or not CB_PASSWORD:
        raise SystemExit(
            "CB_USERNAME / CB_PASSWORD 환경변수가 설정되지 않았습니다.\n"
            ".env.example을 복사해 .env를 만들고 본인 codebeamer 계정 정보를 채우세요."
        )
