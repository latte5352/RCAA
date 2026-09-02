"""PA 아이템의 status 변경 이력(history) 구조를 확인하기 위한 1회성 진단 스크립트.

Create Date 워크플로우를 겪은 것으로 알고 있는 PA 아이템 ID를 인자로 넘기면,
해당 아이템의 전체 history를 콘솔에 요약 출력하고 원본 JSON을 파일로 저장한다.
(check_eventbased_create_date 재설계를 위해, status 변경이 아닌 일반 필드
수정과 Create Date/back 전이가 실제로 어떻게 구별되는지 확인하는 용도)

계정/비밀번호는 파일에 저장하지 않고 실행할 때마다 터미널에서 직접 입력받는다.

사용법: python debug_history.py <PA_ITEM_ID>
"""
import getpass
import json
import sys
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

BASE_URL = "https://codebeamer.slworld.com/cb/rest"

if len(sys.argv) < 2:
    print("사용법: python debug_history.py <PA_ITEM_ID>")
    sys.exit(1)

item_id = sys.argv[1]
username = input("codebeamer 계정: ")
password = getpass.getpass("비밀번호: ")

session = requests.Session()
session.auth = HTTPBasicAuth(username, password)

resp = session.get(f"{BASE_URL}/item/{item_id}/history")
resp.raise_for_status()
history = resp.json()

out_path = Path(__file__).parent / f"history_{item_id}.json"
out_path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"전체 원본 JSON 저장: {out_path}")
print()
print(f"총 히스토리 항목 수: {len(history)}")
print("-" * 80)

for i, h in enumerate(history):
    submitted_at = h.get("submittedAt", "")
    transition = h.get("transition")
    changes = h.get("changes", [])
    print(f"[{i}] {submitted_at}  transition={transition!r}")
    for c in changes:
        field = c.get("field")
        old_val = c.get("oldValue")
        new_val = c.get("newValue")
        # 값이 너무 길면 잘라서 출력
        old_str = json.dumps(old_val, ensure_ascii=False)[:80]
        new_str = json.dumps(new_val, ensure_ascii=False)[:80]
        print(f"    field={field!r}  old={old_str}  new={new_str}")
    if not changes:
        print("    (changes 없음)")
