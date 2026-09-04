"""Test Result 트래커의 아이템 목록 구조를 확인하기 위한 진단 스크립트.

"PA 역할을 하는 워크아이템"을 어떤 필드로 구분해야 하는지 확인하는 용도.
계정/비밀번호는 파일에 저장하지 않고 실행할 때마다 터미널에서 직접 입력받는다.

사용법: python debug_test_result_items.py <TEST_RESULT_TRACKER_ID>
"""
import getpass
import json
import sys
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

BASE_URL = "https://codebeamer.slworld.com/cb/rest"

if len(sys.argv) < 2:
    print("사용법: python debug_test_result_items.py <TEST_RESULT_TRACKER_ID>")
    sys.exit(1)

tracker_id = sys.argv[1]
username = input("codebeamer 계정: ")
password = getpass.getpass("비밀번호: ")

session = requests.Session()
session.auth = HTTPBasicAuth(username, password)

resp = session.get(f"{BASE_URL}/tracker/{tracker_id}/items")
resp.raise_for_status()
data = resp.json()

out_path = Path(__file__).parent / f"tracker_{tracker_id}_items.json"
out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"전체 원본 JSON 저장: {out_path}")

items = data.get("items", [])
print(f"\n총 아이템 수: {len(items)}")
print("-" * 80)

for item in items:
    print(f"id={item.get('id')}  name={item.get('name')!r}")
    print(f"  type={item.get('type')}")
    print(f"  parent={item.get('parent')}")
    print(f"  status={item.get('status')}")
    print()
