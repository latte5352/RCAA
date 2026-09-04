"""트래커의 워크플로우(상태 전이) 정의가 codebeamer API 어디에 있는지 확인하기 위한 진단 스크립트.

"Create Date" 전이가 있는지로 이벤트성 산출물 트래커를 판별하려면, 먼저 트래커 설정 API
응답에 워크플로우 정보가 어떻게 들어있는지 봐야 한다.

계정/비밀번호는 파일에 저장하지 않고 실행할 때마다 터미널에서 직접 입력받는다.

사용법: python debug_tracker_workflow.py <TRACKER_ID>
  TRACKER_ID는 URI가 아니라 숫자만 (예: /tracker/8627105 면 8627105)
"""
import getpass
import json
import sys
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

BASE_URL = "https://codebeamer.slworld.com/cb/rest"

if len(sys.argv) < 2:
    print("사용법: python debug_tracker_workflow.py <TRACKER_ID>")
    sys.exit(1)

tracker_id = sys.argv[1]
username = input("codebeamer 계정: ")
password = getpass.getpass("비밀번호: ")

session = requests.Session()
session.auth = HTTPBasicAuth(username, password)

# 1. 트래커 자체 정보
resp = session.get(f"{BASE_URL}/tracker/{tracker_id}")
print(f"[1] GET /tracker/{tracker_id} -> {resp.status_code}")
if resp.status_code == 200:
    data = resp.json()
    out_path = Path(__file__).parent / f"tracker_{tracker_id}.json"
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"    저장: {out_path}")
    print(f"    최상위 키: {list(data.keys())}")

# 2. 워크플로우 관련일 것 같은 하위 경로들 시도
candidate_paths = [
    f"/tracker/{tracker_id}/workflow",
    f"/tracker/{tracker_id}/workflows",
    f"/tracker/{tracker_id}/type",
    f"/tracker/{tracker_id}/schema",
]
for path in candidate_paths:
    resp = session.get(f"{BASE_URL}{path}")
    print(f"[?] GET {path} -> {resp.status_code}")
    if resp.status_code == 200:
        data = resp.json()
        safe_name = path.strip("/").replace("/", "_")
        out_path = Path(__file__).parent / f"{safe_name}.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"    저장: {out_path}")
