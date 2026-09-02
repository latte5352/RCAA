import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
import json
import numpy as np
from tqdm import tqdm
from pathlib import Path


PR_WORKITEM_FIELD_ID = 1006  # E_PR_Edit.py와 동일한 필드: CIL 아이템에 연결된 PR 작업항목 참조


def _has_unresolved_pr(item_data, auth):
    """이 CIL 아이템에 이미 연결된 PR이 있고, 그 PR이 아직 Closed가 아니면 True.

    codebeamer 워크플로우가 상태를 NG로 바꿀 때마다 새 PR을 만들기 때문에,
    지난주에 발행된 PR이 아직 처리 중인데 또 NG로 전이시키면 PR이 중복 발행된다.
    """
    for field in item_data.get('customFields', []):
        if field.get('fieldId') != PR_WORKITEM_FIELD_ID:
            continue
        for value in field.get('values', []):
            pr_id = value.get('id')
            if not pr_id:
                continue
            pr_resp = requests.get(
                f"https://codebeamer.slworld.com/cb/rest/v3/items/{pr_id}",
                auth=auth, headers={'accept': 'application/json'}
            )
            if pr_resp.status_code == 200 and pr_resp.json().get('status', {}).get('name') != 'Closed':
                return True
    return False


def NG(BASE_URL, USERNAME, PASSWORD, item_id, save_rule, version_rule, history_rule, status_rule, comment_text):
    FIELD_ID_AUDIT_COMMENT = 10016
    BASE_URL = f"https://codebeamer.slworld.com/cb/rest/v3/items/{item_id}"
    auth = HTTPBasicAuth(USERNAME, PASSWORD)

    # 1. 기존 데이터 조회
    res = requests.get(BASE_URL, auth=auth, headers={'accept': 'application/json'})
    if res.status_code != 200:
        print(f"조회 실패: {res.status_code}")
        return
    item_data = res.json()

    status_name = item_data.get('status', {}).get('name')
    if status_name == "NG": # 상태가 NG(id: 3)이면 업데이트 생략
        return

    choice_updates = {
        1016: save_rule,
        1011: version_rule,
        1012: history_rule,
        1013: status_rule
    }

    is_ng_found = any(val == 2 for val in choice_updates.values())
    if is_ng_found and _has_unresolved_pr(item_data, auth):
        print(f"[{item_id}] 기존에 발행된 PR이 아직 Closed가 아니라 NG 갱신(및 재발행)을 건너뜁니다.")
        return

    # 기존 데이터인 Custom Fields 재구성====================================================================================
    target_ids = list(choice_updates.keys()) + [FIELD_ID_AUDIT_COMMENT]
    updated_custom_fields = []
    
    # 3. 기존 필드들 중 안전한 것만 필터링하여 추가
    for f in item_data.get('customFields', []):
        f_id = f.get('fieldId')
        # 1009처럼 수정 불가능한 필드는 건너뜁니다.
        if f_id == 1009:  # Configuration Status는 수정할 수 없는 영역이므로, 에러 방지를 위하여 패스
            continue
        # 우리가 수정하려는 대상 필드도 제외 (새로 덮어쓰기 위해)
        if f_id not in target_ids:
            updated_custom_fields.append(f)

    for f_id, v_id in choice_updates.items():
        updated_custom_fields.append({
            "fieldId": f_id,
            "type": "ChoiceFieldValue",
            "values": [{"id": v_id, "type": "ChoiceOptionReference"}]
        })
    updated_custom_fields.append({
        "fieldId": FIELD_ID_AUDIT_COMMENT,
        "type": "TextFieldValue",
        "value": comment_text
    }) #========================================================================================================

    # 상태를 'Open' (id: 5)으로 먼저 변경====================================
    new_status = {
        "status": {
            "id": 5,
            "name": "Open",
            "type": "ChoiceOptionReference"
        }
    }
    requests.put(
        BASE_URL,
        auth=auth,
        headers={'Content-Type': 'application/json', 'accept': 'application/json'},
        data=json.dumps(        {"name": item_data.get('name'),
        "description": item_data.get('description'),
        "status": new_status,
        "priority": item_data.get('priority'),
        "customFields": updated_custom_fields,
        "subjects": item_data.get('subjects', []),
            "endDate": item_data.get('endDate')})
    )#==================================================================

    # NG, OK 중에 하나로 변경==============================================================
    new_status = {
        "id": 3 if is_ng_found else 2,
        "name": "NG" if is_ng_found else "OK",
        "type": "ChoiceOptionReference"
    }
    payload = {
        "name": item_data.get('name'),
        "description": item_data.get('description'),
        "status": new_status,
        "priority": item_data.get('priority'),
        "customFields": updated_custom_fields,
        "subjects": item_data.get('subjects', []),
        "endDate": item_data.get('endDate')
    }

    # 5. 전송
    response = requests.put(
        BASE_URL,
        auth=auth,
        headers={'Content-Type': 'application/json', 'accept': 'application/json'},
        data=json.dumps(payload)
    ) #==============================================================================


def _load_merged_rows(audit_file=None, cil_file=None):
    audit_file = Path(audit_file) if audit_file else Path(__file__).parent / "B_CM_Audit.xlsx"
    cil_file = Path(cil_file) if cil_file else Path(__file__).parent / "B_CM_CIL.xlsx"
    df1 = pd.read_excel(audit_file)
    df2 = pd.read_excel(cil_file)

    df1 = df1[['트래커명', '저장 규칙', '버전 규칙', '문서 이력 기술 규칙', '상태 규칙', 'Comment']]
    df2 = df2[['트래커명', 'CIL_ID']]
    df1['트래커명'] = df1['트래커명'].str.replace(r'\[.*?\]', '', regex=True).str.strip() # 대괄호 내용 삭제
    merged_df = pd.merge(df1, df2, on='트래커명', how='inner')

    # 저장 규칙, 버전 규칙, 문서 이력 기술 규칙, 상태 규칙 중에서 NaN값이 있으면 1로 변경하고, Comment 중에서 Nan이 있으면 "이상 없음"로 변경
    merged_df['저장 규칙'] = merged_df['저장 규칙'].fillna(1)
    merged_df['버전 규칙'] = merged_df['버전 규칙'].fillna(1)
    merged_df['문서 이력 기술 규칙'] = merged_df['문서 이력 기술 규칙'].fillna(1)
    merged_df['상태 규칙'] = merged_df['상태 규칙'].fillna(1)
    merged_df['Comment'] = merged_df['Comment'].fillna("이상 없음")
    return merged_df


def list_pending_updates(audit_file=None, cil_file=None):
    """codebeamer에 반영하기 전, 검토용으로 대상 항목 목록을 반환한다."""
    merged_df = _load_merged_rows(audit_file, cil_file)
    return [
        {
            "cil_id": int(row['CIL_ID']),
            "tracker_name": row['트래커명'],
            "save_rule": int(row['저장 규칙']),
            "version_rule": int(row['버전 규칙']),
            "doc_history_rule": int(row['문서 이력 기술 규칙']),
            "status_rule": int(row['상태 규칙']),
            "comment": row['Comment'],
        }
        for _, row in merged_df.iterrows()
    ]


def NG_Update(BASE_URL, USERNAME, PASSWORD, audit_file=None, cil_file=None, excluded_cil_ids=None):
    merged_df = _load_merged_rows(audit_file, cil_file)
    excluded_cil_ids = set(excluded_cil_ids or [])

    for _, row in tqdm(merged_df.iterrows(), total=len(merged_df), desc="Codebeamer 업데이트 중"):
        if int(row['CIL_ID']) in excluded_cil_ids: # 사용자가 검토 화면에서 체크 해제한 항목은 반영하지 않고 건너뜀
            continue
        NG(BASE_URL, USERNAME, PASSWORD, row['CIL_ID'], row['저장 규칙'], row['버전 규칙'], row['문서 이력 기술 규칙'], row['상태 규칙'], row['Comment'])

if __name__ == "__main__":
    import config

    config.require_credentials()
    NG(config.BASE_URL, config.CB_USERNAME, config.CB_PASSWORD,
         1074134, # CIL 내 아이템 ID (수동 테스트용)
         1, 2, 2, 1, # 저장 규칙, 버전 규칙, 문서 이력 기술 규칙, 상태 준수
         "문제 없음" # Audit Comment
     )