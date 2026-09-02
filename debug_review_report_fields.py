"""Review Report PA 아이템의 customFields 구조를 확인하기 위한 1회성 진단 스크립트.

"대상 산출물 버전" 필드가 실제로 어떤 fieldId/label로 저장되어 있는지 확인하는 용도.
계정/비밀번호는 파일에 저장하지 않고 실행할 때마다 터미널에서 직접 입력받는다.

사용법: python debug_review_report_fields.py <REVIEW_REPORT_PA_ITEM_ID>
"""
import getpass
import json
import sys
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

BASE_URL = "https://codebeamer.slworld.com/cb/rest"

if len(sys.argv) < 2:
    print("사용법: python debug_review_report_fields.py <REVIEW_REPORT_PA_ITEM_ID>")
    sys.exit(1)

item_id = sys.argv[1]
username = input("codebeamer 계정: ")
password = getpass.getpass("비밀번호: ")

session = requests.Session()
session.auth = HTTPBasicAuth(username, password)

resp = session.get(f"{BASE_URL}/v3/items/{item_id}")
resp.raise_for_status()
item_data = resp.json()

out_path = Path(__file__).parent / f"item_{item_id}.json"
out_path.write_text(json.dumps(item_data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"전체 원본 JSON 저장: {out_path}")
print()
print(f"아이템 이름: {item_data.get('name')}")
print("-" * 80)
print("description 필드:")
print(item_data.get("description"))
print("-" * 80)
print("customFields 목록:")

for field in item_data.get("customFields", []):
    print(f"  {json.dumps(field, ensure_ascii=False)}")

print("-" * 80)
print("comments 조회 시도:")
try:
    comments_resp = session.get(f"{BASE_URL}/v3/items/{item_id}/comments")
    if comments_resp.status_code == 200:
        comments = comments_resp.json()
        comments_path = Path(__file__).parent / f"item_{item_id}_comments.json"
        comments_path.write_text(json.dumps(comments, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  comments 저장: {comments_path} (개수: {len(comments) if isinstance(comments, list) else '?'})")
    else:
        print(f"  comments 조회 실패 (상태 코드 {comments_resp.status_code})")
except Exception as e:
    print(f"  comments 조회 중 에러: {e}")
