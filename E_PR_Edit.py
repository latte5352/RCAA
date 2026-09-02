import os
import requests
from requests.auth import HTTPBasicAuth
import json
from datetime import datetime, timezone
import time

BASE_URL_V3 = "https://codebeamer.slworld.com/cb/api/v3"

# 타겟 프로젝트 및 트래커 정보
PROJECT_ID = 206
TARGET_TRACKER_NAME = "[SUP.8]Configuration Item List"

# 커스텀 필드 ID (PR 관련 필드 및 프로세스 필드)
PR_WORKITEM_FIELD_ID = 1006
CIL_PROCESS_FIELD_ID = 1001

# 프로세스 이름을 Codebeamer 내장 ID로 매핑하는 딕셔너리
PR_PROCESS_MAP = {
    "MAN.3": 1, "MAN.5": 2, "MAN.6": 3, "SUP.1": 4,
    "SUP.2": 5, "SUP.4": 6, "SUP.8": 7, "SUP.9": 8, "SUP.10": 9,
    "SAF.8A": 10, "SAF.8B": 11, "SAF.8C": 12, "SAF.2": 13, "SAF.3A": 14,
    "SAF.3B": 15, "SYS.1": 16, "SYS.2": 17, "SYS.3": 18, "SYS.4B": 19,
    "SYS.5": 20, "VAL.1": 21, "HWE.1": 22, "HWE.2": 23, "HWE.3": 24,
    "HWE.4": 25, "SWE.1": 26, "SWE.2": 27, "SWE.3": 28, "SWE.4": 29,
    "SWE.5": 30, "SWE.6": 31, "SYS.4A": 32, "ACQ.2": 33, "ACQ.4": 34,
    "SPL.2": 35, "기타": 36
}

def get_tracker_id_by_name(session, project_id, tracker_name):
  
    #프로젝트 ID와 트래커 이름을 기반으로 해당 트래커의 고유 ID를 조회하는 함수

    url = f"{BASE_URL_V3}/projects/{project_id}/trackers"
    headers = {"Accept": "application/json"}
    
    try:
        response = session.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            # API 응답 구조에 따라 트래커 목록 추출
            trackers = data.get("items", data) if isinstance(data, dict) else data
            
            # 일치하는 트래커 이름을 찾아 ID 반환
            for tracker in trackers:
                if tracker.get("name") == tracker_name:
                    return tracker.get("id")
                    
            print(f"프로젝트 {project_id}에서 '{tracker_name}' 트래커를 찾을 수 없습니다.")
            return None
        else:
            print(f"트래커 목록 조회 실패 (상태 코드: {response.status_code})")
            return None
    except Exception as e:
        print(f"트래커 조회 통신 에러 발생: {e}")
        return None

def fetch_all_cil_items(session, tracker_id):

    # 특정 트래커 내의 모든 CIL(Configuration Item List) 아이템을 조회하여 리스트로 반환하는 함수 (페이지네이션 처리)

    items = []
    page = 1
    page_size = 100
    url = f"{BASE_URL_V3}/items/query"
    headers = {"Accept": "application/json"}
    
    while True:
        # 트래커 ID로 필터링하는 cbQL (Codebeamer Query Language) 페이로드
        payload = {
            "queryString": f"tracker.id='{tracker_id}'",
            "page": page,
            "pageSize": page_size
        }
        
        try:
            response = session.post(url, headers=headers, json=payload)
            if response.status_code == 200:
                data = response.json()
                fetched_items = data.get("items", [])
                
                # 더 이상 가져올 아이템이 없으면 루프 종료
                if not fetched_items:
                    break
                
                items.extend(fetched_items)
                print(f"데이터 수집 중... ({page}페이지, {len(items)}개 누적)")
                
                # 전체 아이템 수를 모두 가져왔으면 루프 종료
                if len(items) >= data.get("total", 0):
                    break
                    
                page += 1
            else:
                print(f"CIL 아이템 조회 실패 (상태 코드: {response.status_code})")
                break
        except Exception as e:
            print(f"에러 발생: {e}")
            break
            
    return items

def extract_data_from_item(item_data):

    # 단일 CIL 아이템 데이터에서 PR ID 목록, Work Item ID, 생성자 ID, 프로세스 이름을 추출하는 함수

    pr_ids = []
    work_item_id = None
    creator_id = None
    process_name = None 
    
    # 커스텀 필드 파싱
    custom_fields = item_data.get("customFields", [])
    for field in custom_fields:
        if field.get("fieldId") == PR_WORKITEM_FIELD_ID:
            # PR 아이템 참조 ID 추출
            values = field.get("values", [])
            pr_ids = [val.get("id") for val in values if val.get("id")]
                
        elif field.get("fieldId") == CIL_PROCESS_FIELD_ID:
            # 프로세스 이름 추출
            values = field.get("values", [])
            if values:
                process_name = values[0].get("name")
    
    # Subject(상위/연결 아이템) 파싱하여 Work Item ID 추출
    subjects = item_data.get("subjects", [])
    if subjects:
        work_item_id = subjects[0].get("id")
        
    # 아이템 생성자 파싱하여 Creator ID 추출
    created_by = item_data.get("createdBy", {})
    creator_id = created_by.get("id")
                
    return pr_ids, work_item_id, creator_id, process_name

def is_pr_status_open(session, pr_item_id):

    # 주어진 PR 아이템의 상태가 'Open'인지 확인하는 함수

    url = f"{BASE_URL_V3}/items/{pr_item_id}"
    headers = {"Accept": "application/json"}
    
    try:
        response = session.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            status = data.get("status", {})
            status_name = status.get("name", "")
            
            if status_name == "Open": 
                return True
            else:
                print(f"  -> 업데이트 스킵: PR({pr_item_id})의 상태가 '{status_name}' 입니다.")
                return False
        else:
            print(f"  -> 상태 조회 실패: PR({pr_item_id}) (코드: {response.status_code})")
            return False
    except Exception as e:
        print(f"  -> 상태 조회 통신 에러: {e}")
        return False

def update_pa_fields(session, pr_item_id, work_item_id, creator_id, process_id):

    #대상 PR 아이템의 여러 필드를 동시에 업데이트(부분 업데이트)하는 함수

    url_partial_update = f"{BASE_URL_V3}/items/fields"
    # 현재 시간
    now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000')
    
    # 값 존재 여부에 따른 참조 객체 생성
    related_item_values = [{"id": work_item_id, "type": "TrackerItemReference"}] if work_item_id else []
    analyzer_values = [{"id": creator_id, "type": "UserReference"}] if creator_id else []
    process_values = [{"id": process_id, "type": "ChoiceOptionReference"}] if process_id else []

    # 업데이트할 필드들 내용
    payload = [
        {
            "itemId": pr_item_id,
            "fieldValues": [
                {"fieldId": 10002, "type": "DateFieldValue", "value": now_iso},
                {"fieldId": 1003, "type": "ChoiceFieldValue", "values": [{"id": 2, "type": "ChoiceOptionReference"}]},
                {"fieldId": 1016, "type": "ChoiceFieldValue", "values": related_item_values},
                {"fieldId": 1008, "type": "ChoiceFieldValue", "values": analyzer_values},
                {"fieldId": 10007, "type": "DateFieldValue", "value": now_iso},
                {"fieldId": 1007, "type": "ChoiceFieldValue", "values": [{"id": 3, "type": "ChoiceOptionReference"}]},
                {"fieldId": 10006, "type": "WikiTextFieldValue", "value": "N/A"},
                {"fieldId": 1004, "type": "ChoiceFieldValue", "values": process_values},
                {"fieldId": 1005, "type": "ChoiceFieldValue", "values": [{"id": 4, "type": "ChoiceOptionReference"}]}, 
                {"fieldId": 1006, "type": "ChoiceFieldValue", "values": [{"id": 3, "type": "ChoiceOptionReference"}]},
                {"fieldId": 10005, "type": "WikiTextFieldValue", "value": "N/A"},
                {"fieldId": 1009, "type": "ChoiceFieldValue", "values": [{"id": 2, "type": "ChoiceOptionReference"}]},
                {"fieldId": 1012, "type": "ChoiceFieldValue", "values": [{"id": 2, "type": "ChoiceOptionReference"}]},
                {"fieldId": 7, "type": "ChoiceFieldValue", "values": [{"id": 2, "type": "ChoiceOptionReference"}]}
            ]
        }
    ]
    
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    
    try:
        response = session.put(url_partial_update, headers=headers, json=payload)
        
        # PUT 요청 성공 시 (200 OK 또는 201 Created)
        if response.status_code in [200, 201]:
            print(f"  업데이트 성공 (대상 PR ID: {pr_item_id})")
            return True
        else:
            print(f"  업데이트 실패 (상태 코드: {response.status_code}) | {response.text}")
            return False
    except Exception as e:
        print(f"  통신 에러 발생: {e}")
        return False


def run(USERNAME, PASSWORD, TARGET_TRACKER_NAME):
    with requests.Session() as session:
        session.auth = HTTPBasicAuth(USERNAME, PASSWORD)
        cil_tracker_id = get_tracker_id_by_name(session, PROJECT_ID, TARGET_TRACKER_NAME)
        cil_items = fetch_all_cil_items(session, cil_tracker_id)
        processed_count = 0
        updated_count = 0
        # 로드한 CIL 아이템 반복 처리
        for item in cil_items:
            cil_id = item.get("id")
            # 필요 데이터 추출 (연관 PR, Work Item, 담당자, 프로세스명)
            pr_ids, work_item_id, creator_id, process_name = extract_data_from_item(item)
            
            # 연결된 PR이 존재하는 경우
            if pr_ids:
                for pr_id in pr_ids:
                    processed_count += 1
                    print(f"\n[CIL ID: {cil_id}] - PR({pr_id})")
                    print(f"  - Work Item: {work_item_id}, Creator: {creator_id}, Process: {process_name}")
                    
                    # PR의 상태가 Open인지 체크하여 진행
                    if is_pr_status_open(session, pr_id):
                        target_process_id = PR_PROCESS_MAP.get(process_name)
                        
                        # 업데이트 함수 호출 및 결과에 따른 카운트 증가
                        if update_pa_fields(session, pr_id, work_item_id, creator_id, target_process_id):
                            updated_count += 1

                        # API 호출 과부하 방지를 위한 0.1초 딜레이
                        time.sleep(0.1)

    print(f"\n---  검색된 PR {processed_count}개 중, {updated_count}개의 PR 업데이트 완료 ---")


if __name__ == "__main__":
    import config

    config.require_credentials()
    run(config.CB_USERNAME, config.CB_PASSWORD, TARGET_TRACKER_NAME)

