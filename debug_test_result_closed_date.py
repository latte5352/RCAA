"""Test Result 트래커의 대표(Parent-less) 워크아이템이 Finished/Closed 상태로
"마지막으로" 전이된 시각을 어떤 필드/방법으로 알아낼 수 있는지 확인하는 진단 스크립트.

계정/비밀번호는 파일에 저장하지 않고 실행할 때마다 터미널에서 직접 입력받는다.

사용법: python debug_test_result_closed_date.py <TEST_RESULT_PA_ITEM_ID> <TEST_RESULT_TRACKER_ID>
  (예: 이전에 확인된 tracker 8145882의 대표 아이템 id 2269410 -> python debug_test_result_closed_date.py 2269410 8145882)

TRACKER_ID를 같이 주면, 실제 파이프라인(B_Audit_Data_Creation.py)이 쓰는 것과 동일한
"/tracker/{id}/items" 목록 응답에서도 해당 필드가 그대로 오는지 같이 확인한다
(item 단건 상세 응답과 필드가 다를 수 있어서 반드시 같이 확인 필요).
"""
import getpass
import json
import sys
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth

BASE_URL = "https://codebeamer.slworld.com/cb/rest"

if len(sys.argv) < 2:
    print("사용법: python debug_test_result_closed_date.py <TEST_RESULT_PA_ITEM_ID> [<TEST_RESULT_TRACKER_ID>]")
    sys.exit(1)

item_id = sys.argv[1]
tracker_id = sys.argv[2] if len(sys.argv) > 2 else None
username = input("codebeamer 계정: ")
password = getpass.getpass("비밀번호: ")

session = requests.Session()
session.auth = HTTPBasicAuth(username, password)

if tracker_id:
    resp0 = session.get(f"{BASE_URL}/tracker/{tracker_id}/items")
    resp0.raise_for_status()
    items0 = resp0.json().get("items", [])
    match = next((it for it in items0 if str(it.get("id")) == str(item_id)), None)
    print("=== /tracker/{id}/items 목록 응답에서 해당 아이템 ===")
    if match is None:
        print("  (목록에서 해당 id를 찾지 못함)")
    else:
        for k, v in match.items():
            print(f"  {k} = {v!r}")
    print()

# 1) 아이템 상세 (v2) - "Closed At" 류의 필드가 최상위에 직접 있는지 확인
resp = session.get(f"{BASE_URL}/item/{item_id}")
resp.raise_for_status()
item_data = resp.json()

out_path = Path(__file__).parent / f"item_{item_id}_detail.json"
out_path.write_text(json.dumps(item_data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"아이템 상세 원본 JSON 저장: {out_path}")

print("\n=== 아이템 상세 - 'close'가 이름에 들어간 필드 ===")
for k, v in item_data.items():
    if "close" in k.lower():
        print(f"  {k} = {v!r}")

print("\n=== 아이템 상세 - 날짜/시각으로 보이는 필드 전체 ===")
for k, v in item_data.items():
    if isinstance(v, str) and ("T" in v and "-" in v and ":" in v):
        print(f"  {k} = {v!r}")
print(f"  status = {item_data.get('status')}")

# 2) 히스토리 (v2) - 각 항목이 어떤 상태로의 전이인지, 시각 필드가 뭔지 전체 구조 확인
resp2 = session.get(f"{BASE_URL}/item/{item_id}/history")
resp2.raise_for_status()
history_data = resp2.json()

out_path2 = Path(__file__).parent / f"item_{item_id}_history.json"
out_path2.write_text(json.dumps(history_data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n히스토리 원본 JSON 저장: {out_path2}")

print(f"\n=== 히스토리 총 {len(history_data)}건 (마지막 5건만 요약 출력) ===")
for h in history_data[-5:]:
    print("-" * 60)
    for k, v in h.items():
        print(f"  {k} = {v!r}")
