import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm
from pathlib import Path


# 콘솔 클리어 함수
def clear_console() :
    if False : # 콘솔 화면 Clear 여부
        os.system('cls' if os.name == 'nt' else 'clear')


TABLE_TOKEN_RE = re.compile(r"\[\{Table|\}\]")


def _find_enclosing_table(comment_text, marker_pos):
    """marker_pos를 포함하는 최상위 [{Table ... }] 블록의 (시작, 끝) 인덱스를 찾는다.
    표 안에 표가 중첩된 경우(예: 대상 문서명 셀 안에 또 표가 있는 경우)까지 고려해
    괄호 깊이를 세어 정확한 끝 지점을 찾는다."""
    open_positions = [m.start() for m in re.finditer(r"\[\{Table", comment_text[:marker_pos])]
    if not open_positions:
        return None
    table_start = open_positions[-1]

    depth = 0
    for m in TABLE_TOKEN_RE.finditer(comment_text, table_start):
        depth += 1 if m.group() == "[{Table" else -1
        if depth == 0:
            return table_start, m.end()
    return None  # 닫히지 않은 표 (형식 이상)


def extract_target_version_from_comment(comment_text):
    """Review Report PA 아이템의 코멘트(자유 텍스트 Wiki 표)에서 "리뷰 대상 문서명" 표에 적힌
    대상 문서 버전을 추출한다. 작성자마다 표 형식이 달라(버전에 'v' 접두사가 있거나 없거나)
    완벽한 파싱은 불가능하므로, 실패 시에는 억지로 판정하지 않고 사유를 같이 반환해 사람이
    직접 확인하도록 한다.

    반환: (버전 문자열 또는 None, 실패 사유 또는 None)
    """
    if not comment_text:
        return None, "리뷰 코멘트가 비어있음"

    marker = "리뷰 대상 문서명"
    start = comment_text.find(marker)
    if start == -1:
        return None, "'리뷰 대상 문서명' 표를 찾을 수 없음"

    # 뒤에 다른 표(관련 문서명 등)가 더 붙어있어도 안 섞이도록, "리뷰 대상 문서명"이 속한
    # 표 자체의 시작~끝(중첩 표 포함)만 정확히 잘라낸다
    table_bounds = _find_enclosing_table(comment_text, start)
    if table_bounds is None:
        return None, "표 구조를 인식하지 못함"
    section = comment_text[table_bounds[0]:table_bounds[1]]

    # codebeamer Wiki 서식: %%(color:rgb(r,g,b);...)내용%! 형태로 셀 내용이 감싸져 있음
    spans = re.findall(r"%%\(color:rgb\([^)]*\)[^)]*\)([^%]+)%!", section)
    cleaned = [s.strip().strip("\\").strip() for s in spans]
    versions = [s for s in cleaned if re.fullmatch(r"v?\d+(\.\d+)+", s, re.IGNORECASE)]
    if not versions:
        return None, "버전 값을 인식하지 못함"

    return versions[-1].lstrip("vV"), None

def Audit_Data_Creation(BASE_URL, BASE_URL_V3, USERNAME, PASSWORD, PROJECT_NAME, TRACKER_NAME_CIL, TRACKER_NAME_NCL):
    session = requests.Session()
    session.auth = HTTPBasicAuth(USERNAME, PASSWORD)
    try:
        def parse_cil_data(data):
            """CIL 데이터 파싱"""
            rows = []
            for item in data.get('items', []):
                work_item = item.get('workItem')
                tracker_name = item.get('name')
                if work_item:
                    target_tracker = work_item.get('tracker', {})
                    tracker_connected = "O"
                    tracker_uri = target_tracker.get('uri')
                else:
                    tracker_connected = "X"
                    tracker_uri = ""
                
                baseline_version = item.get('baselineVersion')
                work_item_status = item.get('workItemStatus')
                status_name = item.get('status', {}).get('name')
                cil_id = item.get('id')
                cil_uri = item.get('uri')
                process_name = item.get('process', {}).get('name')
                management_type = item.get('managementType', {}).get('name')
                
                pr_items = item.get('pRWorkItem', [])
                pr_id = [item.get('name') for item in pr_items]
                pr_id_url = [item.get('tracker', {}).get('uri') for item in pr_items]
                
                storage_rule = item.get('저장규칙준수', {}).get('name')
                version_rule = item.get('버전규칙준수', {}).get('name')
                history_rule = item.get('문서이력기술규칙준수', {}).get('name')
                status_rule = item.get('상태준수', {}).get('name')
                audit_comment = item.get('auditComment')
                
                row = {
                    "CIL_ID": cil_id, "CIL_uri": cil_uri, "트래커명": tracker_name,
                    "TRACKER_Connected": tracker_connected, "TRACKER_uri": tracker_uri,
                    "baselineVersion": baseline_version, "workItemStatus": work_item_status,
                    "프로세스명": process_name, "관리유형": management_type, "PR-ID": pr_id,
                    "PR-ID_url": pr_id_url, "저장 규칙": storage_rule, "버전 규칙": version_rule,
                    "문서 이력 기술 규칙": history_rule, "상태 규칙": status_rule, "comment": audit_comment,
                    "Status": status_name
                }
                rows.append(row)
            return pd.DataFrame(rows)
        
        def parse_baseline_data(data):
            """베이스라인 데이터 파싱"""
            rows = []
            version_pattern = re.compile(r'_v\.?(\d+[\.\d]*)$')
            date_pattern = re.compile(r'(\d{6}\.\d+)$')
            
            for item in data.get('baselines', []):
                name = item.get('name', '')
                
                description = item.get('description') or ""
                
                v_match = version_pattern.search(name)
                d_match = date_pattern.search(name)
                
                version_type = "Other"
                version_val = None
                
                if v_match:
                    version_type = "Version Up"
                    version_val = v_match.group(1)
                elif d_match:
                    version_type = "Create Date"
                    version_val = d_match.group(1)
                
                pr_match = re.search(r'PR~-(\d+)', description)
                cr_match = re.search(r'CR~-(\d+)', description)
                
                pr_id = int(pr_match.group(1)) if pr_match else None
                cr_id = int(cr_match.group(1)) if cr_match else None
                
                # parent가 있을 경우에만 추가 : Parent가 없는 애들은 실제 베이스라인임
                if item.get('parent', {}):
                    row = {
                        "베이스라인ID": item.get('parent', {}).get('id'),
                        "트래커": item.get('parent', {}).get('name'),
                        "버전종류": version_type,
                        "버전": version_val,
                        "담당자": item.get('owner', {}).get('firstName'),
                        "설명": description,
                        "시각": item.get('createdAt'),
                        "PR-ID": pr_id,
                        "CR-ID": cr_id
                    }
                    rows.append(row)
            
            return pd.DataFrame(rows)
        
        def fetch_tracker_items_pa(tracker_or_category):   
            # https://codebeamer.slworld.com/cb/rest/project/206/trackers
            #  {"uri" : "/tracker/8627105",
            #   "name" : "[SUP.1]Hardware Verification-Design Review Specification and Result Audit Report",
            #   "description" : "~[SUP.1~]Hardware Verification~-Design Review Specification and Result Audit Report",
            #   "descFormat" : "Wiki",
            #   "keyName" : "SUP1_HVDRSRAR",
            #   "type" : {
            #     "uri" : "/tracker/type/6",
            #     "name" : "작업"}}
            #"""개별 트래커/카테고리에서 PA 추출 (병렬용)"""
            try:
                tracker_id_uri = tracker_or_category.get('uri')
                tracker_name = tracker_or_category.get('name')
                tracker_type = tracker_or_category.get('type', {}).get('name')
                source = tracker_or_category.get('_source', 'Tracker')
                
                items_url = f"{BASE_URL}{tracker_id_uri}/items"
                items_data = session.get(items_url).json().get('items', [])
                
                result_val = "-"
                if tracker_type == "Document" and len(items_data) == 1:
                    result_val = str(items_data[0].get('id'))
                else:
                    pa_list = [str(item.get('id')) for item in items_data if item.get('type', {}).get('name') == 'Primary Attribute']
                    if pa_list:
                        result_val = ", ".join(pa_list)
                
                if result_val != "-":
                    return {"source": source, "name": tracker_name, "pa": result_val}
                return None
            except Exception:
                return None
        
        def fetch_ncl_relations(item):
            """개별 NCL 아이템 관계 조회 (병렬용)"""
            try:
                item_id = item['id']
                item_name = item['name']
                item_status = item['status']['name']
                
                relations_url = f"{BASE_URL_V3}/items/{item_id}/relations"
                response = session.get(relations_url)
                
                results = []
                if response.status_code == 200:
                    relations_data = response.json()
                    incoming_associations = relations_data.get('incomingAssociations', [])
                    
                    if not incoming_associations:
                        results.append({'PR': item_name, 'CIL_id': None, '상태': item_status})
                    else:
                        for assoc in incoming_associations:
                            revision_id = assoc.get('itemRevision', {}).get('id')
                            if revision_id:
                                results.append({'PR': item_name, 'CIL_id': revision_id, '상태': item_status})
                return results
            except Exception:
                return []
        
        def process_row_parallel(index, df_merged, latest_baselines):
            """최종 감사 리포트 행 처리 (병렬용)"""
            row = df_merged.iloc[index]
            uri = row["TRACKER_uri"]
            if pd.isna(uri) or uri == "": # 이름 매칭으로도 트래커를 못 찾은 경우에만 패스
                return None

            rr_uri = row.get("Review_Report_uri") if not pd.isna(row.get("Review_Report_uri")) else None
            

            tracker = session.get(f"https://codebeamer.slworld.com/cb/rest{uri}").json() # 1. 트래커의 타입 2. 트래커의 이름
            tracker_item = session.get(f"https://codebeamer.slworld.com/cb/rest{uri}/items").json() # PA를 찾고, 1. 최초 작성 2. 최근 수정 3. 상태
            
            rr_data = {"num": "해당없음", "time": "해당없음", "status": "해당없음", "is_upload": "해당없음", "target_version": "", "version_check_fail_reason": ""} # Review Report의 1. 개수 2. 제출 시간 3. 상태 4. 작성 여부 5. 기재된 대상 문서 버전
            if rr_uri:
                rr_resp = session.get(f"https://codebeamer.slworld.com/cb/rest{rr_uri}/items").json()
                items = rr_resp.get('items', [])

                if items:
                    pa_item = next((item for item in items if item.get('type', {}).get('name') == 'Primary Attribute'), None)
                    rr_status = pa_item.get('status', {}).get('name', "") if pa_item else ""

                    target_version, version_check_fail_reason = "", "리뷰레포트 PA 아이템 없음"
                    if pa_item:
                        comments_resp = session.get(f"https://codebeamer.slworld.com/cb/rest/v3/items/{pa_item['id']}/comments")
                        if comments_resp.status_code == 200:
                            comments = comments_resp.json()
                            combined_text = " ".join(c.get('comment', '') or '' for c in comments if isinstance(c, dict))
                            target_version, version_check_fail_reason = extract_target_version_from_comment(combined_text)
                            target_version = target_version or ""
                            version_check_fail_reason = version_check_fail_reason or ""
                        else:
                            version_check_fail_reason = "리뷰 코멘트 조회 실패"

                    rr_data = {
                        "num": len(items),
                        "time": items[0].get("submittedAt", ""),
                        "status": rr_status,
                        "is_upload": rr_status in ['OK', 'NG', 'Review Closed'], # Review Report가 OK, NG, Review Closed 중 1개의 상태를 갖고있다면 작성했다고 판단
                        "target_version": target_version,
                        "version_check_fail_reason": version_check_fail_reason,
                    }
                else:
                    rr_data = {"num": 0, "time": "", "status": "", "is_upload": False, "target_version": "", "version_check_fail_reason": ""}
            
            items = tracker_item.get('items', [])
            pa_ids = [item['id'] for item in items if item.get('type', {}).get('name') == 'Primary Attribute']
            
            pa_history = None
            if pa_ids:
                pa_history = session.get(f"https://codebeamer.slworld.com/cb/rest/item/{pa_ids[0]}/history").json()
            
            t_type = tracker.get("type", {}).get("name", "")
            t_name = tracker.get("name", "")
            
            base = latest_baselines.get(t_name, {}) # 1. 버전 종류 2. 버전 3. 버전 설명 4. 버저닝 시각 5. 담당자
            
            h_info = {"first": "", "last": "", "status": "Open", "waiting": pd.NA, "create_date_current": False}
            if pa_history:
                h_info["first"] = pa_history[0].get('submittedAt', '')
                h_info["last"] = pa_history[-1].get('submittedAt', '')
                h_info["status"] = next((c['newValue']['name'] for h in reversed(pa_history) for c in h.get('changes', [])
                                        if c.get('field') == 'status' and isinstance(c.get('newValue'), dict)), "Open")
                if rr_data["num"] != "해당없음":
                    h_info["waiting"] = True if h_info["status"] in ["Open", "In Review"] else (False if h_info["status"] in ["Waiting for Approval", "Approved"] else "")
                # Create Date는 누르는 즉시 이전 상태(Released/Read Only)로 자동 복귀("back")하기 때문에
                # 현재 상태만으로는 Create Date 여부를 알 수 없다. 가장 최근 히스토리 항목이 "back" 전이라는 것 자체가
                # "마지막으로 한 일이 Create Date였다(그 이후 다른 수정이 없었다)"는 뜻이라 이걸로 최신 여부를 판단한다.
                last_transition = pa_history[-1].get('transition') or {}
                h_info["create_date_current"] = last_transition.get('name') == 'back'
            
            return {
                "트래커명": t_name,
                "트래커타입": t_type,
                "버전 종류": base.get("버전종류", "미업로드"),
                "트래커 아이템 개수": len(items),
                "트래커 파일명": items[0].get("fileName", "") if t_type == "Document" and items else "",
                "첫 Edit 시각": h_info["first"],
                "최근 Edit 시각": h_info["last"],
                "현재 상태": h_info["status"],
                "현재 버전": base.get("버전", "미업로드"),
                "매칭 PR-ID": row["관련PR"],
                "버저닝 최근 시각": base.get("시각", ""),
                "버전 설명": base.get("설명", ""),
                "리뷰레포트 점검 항목 개수": rr_data["num"],
                "리뷰레포트 점검 상태": rr_data["status"],
                "리뷰레포트 업로드 여부": rr_data["is_upload"],
                "Waiting for Approval 이전 상태": h_info["waiting"],
                "리뷰레포트 최근 업로드 시각": rr_data["time"],
                "담당자": base.get("담당자", ""),
                "Create Date 최신 여부": h_info["create_date_current"],
                "리뷰레포트 기재 버전": rr_data["target_version"],
                "버전 확인 실패 사유": rr_data["version_check_fail_reason"]
            }

        
        # ============================================================================
        # [시작] 프로젝트 URI 및 기본 데이터 조회
        # ============================================================================
        clear_console()
        pbar_init = tqdm(total=1, desc="[초기화] 프로젝트 정보 로드", position=0, leave=True)
        
        result = session.get(f"{BASE_URL}/projects/page/1").json()
        result = [t for t in result.get('projects', []) if PROJECT_NAME in t.get('name', "")]
        userURI = BASE_URL + result[0]['uri']
        
        pbar_init.update(1)
        pbar_init.close()
        
        # ============================================================================
        # [Phase 1-5] 병렬 데이터 수집 (독립적 작업)
        # ============================================================================
        
        def phase_1_pa_extraction():
            """Phase 1: PA 데이터 추출"""
            clear_console()
            pbar = tqdm(total=100, desc="[Phase 1] PA 데이터 수집", position=0, leave=True)
            
            trackers = session.get(f"{userURI}/trackers").json()
            categories = session.get(f"{userURI}/categories").json()
            
            pbar.update(10)
            
            # 트래커와 카테고리에 소스 정보 추가
            for t in trackers:
                t['_source'] = 'Tracker'
            for c in categories:
                c['_source'] = 'Category'
            
            all_items = trackers + categories
            
            # 병렬 처리
            collected_data = []
            with ThreadPoolExecutor(max_workers=20) as executor:
                futures = [executor.submit(fetch_tracker_items_pa, item) for item in all_items]
                for future in tqdm(as_completed(futures), total=len(futures), desc="[Phase 1-Sub] 병렬 PA 조회", position=1, leave=False):
                    result = future.result()
                    if result:
                        collected_data.append(result)
            
            df_pa = pd.DataFrame(collected_data)
            df_pa['name'] = df_pa['name'].apply(lambda x: x.split(']')[-1].strip() if ']' in x else x)
            
            pbar.update(100)
            pbar.close()
            return df_pa
        
        def phase_2_cil_extraction():
            """Phase 2: CIL 데이터 추출"""
            clear_console()
            pbar = tqdm(total=100, desc="[Phase 2] CIL 데이터 추출", position=0, leave=True)
            
            result = session.get(f"{userURI}/trackers").json()
            result = [item for item in result if item.get('name') == TRACKER_NAME_CIL]
            trackerURI = BASE_URL + result[0]['uri']
            
            pbar.update(20)
            
            result = session.get(f"{trackerURI}/items").json()
            
            items_list = result.get('items', [])
            extracted_rows = []
            for item in items_list:
                extracted_rows.append({"name": item.get('name', 'N/A'), "CIL_address": item.get('id')})
            
            df_items = pd.DataFrame(extracted_rows) 
            # df_items(첫번째 리턴값)
            #  |                       name               |CIL_address|
            #  |------------------------------------------|-----------|
            #  | Validation Report                        |  1062742  |
            #  | Stakeholder Requirements Analysis        |  1062740  |
            #  | Validation Specification Review Report   |  1062738  |
            pbar.update(20)
            


            df_cil = parse_cil_data(result)
            # df_cil
            # |  CIL_ID |    CIL_uri    |             트래커명               | TRACKER_Connected |   TRACKER_uri  | baselineVersion | workItemStatus | 프로세스명 | 관리유형 | PR-ID | PR-ID_url | 저장 규칙 | 버전 규칙 | 문서 이력 기술 규칙 | 상태 규칙 | comment | Status |
            # |---------|---------------|-----------------------------------|-------------------|----------------|-----------------|----------------|----------|---------|-------|-----------|---------|----------|-------------------|---------|---------|--------|
            # | 1062742 | /item/1062742 | Validation Report                 |         X         |       None     |       None      |      None      |  VAL.1   | 버전관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open |
            # | 1062740 | /item/1062740 | Stakeholder Requirements Analysis |         O         |/tracker/8642282|        ...      |  Audit Closed  |  VAL.1   | 저장관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open |
            pbar.update(30)
            
            result = session.get(f"{userURI}/trackers").json()
            result2 = session.get(f"{userURI}/categories").json()
            
            df_trackers = pd.DataFrame([(item['uri'], item['name']) for item in result], columns=['uri', 'name'])
            df_cats = pd.DataFrame([(item['uri'], item['name']) for item in result2], columns=['uri', 'name'])
            
            df_tracker_map = pd.concat([df_trackers, df_cats], ignore_index=True)
            df_tracker_map = df_tracker_map[df_tracker_map['name'].str.contains(r'\[.*\]', regex=True)].copy()
            df_tracker_map['name'] = df_tracker_map['name'].str.replace(r'\[.*?\]', '', regex=True).str.strip()
            # df_tracker_map
            #|        uri        |                  name                  |
            #| ----------------- | -------------------------------------- |
            #| /tracker/8625746  | Change Request                         |
            #| /tracker/8625840  | Quality Assurance Plan Audit Report    |
            
            pbar.update(10)
            
            df_merged = df_cil.merge(df_tracker_map, left_on='트래커명', right_on='name', how='outer') # CIL상의 트래커명과 트래커 탭 상의 트래커명이 서로 같은 것만 추출
            df_merged['TRACKER_uri'] = df_merged.apply(
                lambda row: row['uri'] if pd.isna(row['TRACKER_uri']) or row['TRACKER_uri'] == "" else row['TRACKER_uri'],
                axis=1
            )
            df_merged.drop(columns=['name', 'uri'], inplace=True)
            # 트래커는 실제로 존재하는데 CIL(Configuration Item List)에 등록된 항목이 없는 경우(CIL_ID가 없음)를
            # 버리기 전에 따로 빼둔다 - 감사 대상에서 조용히 누락되지 않도록 검토 화면에 별도로 보여주기 위함
            df_unregistered = df_merged[df_merged['CIL_ID'].isna()][['트래커명', 'TRACKER_uri']].copy()
            df_unregistered.drop_duplicates(subset=['TRACKER_uri'], inplace=True)
            df_merged.dropna(subset=[df_merged.columns[0]], inplace=True)
            df_merged.drop_duplicates(subset=['TRACKER_uri'], inplace=True)
            # df_merged(실제 있는 트래커명만 남김)
            # |  CIL_ID |    CIL_uri    |             트래커명               | TRACKER_Connected |   TRACKER_uri  | baselineVersion | workItemStatus | 프로세스명 | 관리유형 | PR-ID | PR-ID_url | 저장 규칙 | 버전 규칙 | 문서 이력 기술 규칙 | 상태 규칙 | comment | Status |
            # |---------|---------------|-----------------------------------|-------------------|----------------|-----------------|----------------|----------|---------|-------|-----------|---------|----------|-------------------|---------|---------|--------|
            # | 1062742 | /item/1062742 | Validation Report                 |         X         |       None     |       None      |      None      |  VAL.1   | 버전관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open |
            # | 1062740 | /item/1062740 | Stakeholder Requirements Analysis |         O         |/tracker/8642282|        ...      |  Audit Closed  |  VAL.1   | 저장관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open |
            
            # Review Report 연결
            df_reviews = df_merged[df_merged['트래커명'].str.contains(' Review Report', na=False)].copy() # Review Report 트래커만 선별
            df_reviews['Join_Key'] = df_reviews['트래커명'].str.replace(' Review Report', '', regex=False) 
            df_reviews = df_reviews[['Join_Key', 'TRACKER_uri']].rename(columns={'TRACKER_uri': 'Review_Report_uri'}) # 매칭할 트래커명과 해당 Review Report 트래커 URI만 사용
            # df_reviews
            #|             Join_Key            | Review_Report_uri |
            #| ------------------------------- | ----------------- |
            #| Change Request Management Plan  | /tracker/8654478  |
            #| Configuration Management Plan   | /tracker/8654222  |
            
            df_merged = pd.merge(df_merged, df_reviews, left_on='트래커명', right_on='Join_Key', how='left') # 병합하면서 df_merged에 Review_Report_uri 열 추가
            df_merged = df_merged.drop(columns=['Join_Key'])
            # df_merged(두번째 리턴값)
            # |  CIL_ID |    CIL_uri    |             트래커명               | TRACKER_Connected |   TRACKER_uri  | baselineVersion | workItemStatus | 프로세스명 | 관리유형 | PR-ID | PR-ID_url | 저장 규칙 | 버전 규칙 | 문서 이력 기술 규칙 | 상태 규칙 | comment | Status | Revuew_Report_uri |
            # |---------|---------------|-----------------------------------|-------------------|----------------|-----------------|----------------|----------|---------|-------|-----------|---------|----------|-------------------|---------|---------|--------| ----------------- |
            # | 1062742 | /item/1062742 | Validation Report                 |         X         |       None     |       None      |      None      |  VAL.1   | 버전관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654478  |
            # | 1062740 | /item/1062740 | Stakeholder Requirements Analysis |         O         |/tracker/8642282|        ...      |  Audit Closed  |  VAL.1   | 저장관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654222  |
            
            pbar.update(20)
            pbar.close()
            return df_merged, df_items, df_unregistered

        def phase_3_baseline_extraction():
            """Phase 3: 베이스라인 데이터 추출"""
            clear_console()
            pbar = tqdm(total=100, desc="[Phase 3] 베이스라인 추출", position=0, leave=True)
            
            project_id = userURI.split('/')[-1] # https://codebeamer.slworld.com/cb/rest/project/206 => 206 추출
            baselines_url = f"https://codebeamer.slworld.com/cb/rest/projects/{project_id}/baselines"
            result = session.get(f"{baselines_url}").json()
            df2 = parse_baseline_data(result)
            
            pbar.update(100)
            pbar.close()
            return df2
        
        def phase_4_ncl_extraction():
            """Phase 4: NCL 데이터 추출"""
            clear_console()
            pbar = tqdm(total=100, desc="[Phase 4] NCL 데이터 추출", position=0, leave=True)
            
            result = session.get(f"{userURI}/trackers").json()
            result = [item for item in result if item.get('name') == TRACKER_NAME_NCL]
            trackerURI_ncl = BASE_URL + result[0]['uri']
            result = session.get(f"{trackerURI_ncl}/items").json()
            
            pbar.update(20)
            
            ncl_items = result['items']
            
            # 병렬 처리
            all_extracted_data = []
            with ThreadPoolExecutor(max_workers=20) as executor:
                futures = [executor.submit(fetch_ncl_relations, item) for item in ncl_items]
                for future in tqdm(as_completed(futures), total=len(futures), desc="[Phase 4-Sub] 병렬 관계 조회", position=1, leave=False):
                    results = future.result()
                    all_extracted_data.extend(results)
            
            pbar.update(60)
            
            df_ncl = pd.DataFrame(all_extracted_data)
            # df_ncl
            # |    PR   |   CIL_id  | 상태 |
            # |---------|-----------|------|
            # | PR-1269 | NaN       | Open |
            # | PR-1288 | 1062342.0 | Open |
            # | PR-1287 | 1062342.0 | Open |

            # df_ncl이 비어있는지(empty)
            if df_ncl is None or df_ncl.empty:
                # 비어있다면 오류를 막기 위해 열 이름만 생성
                result_ncl = pd.DataFrame(columns=['PR_num', 'CIL_id', '상태'])
            else:
                # 상태가 Closed인 애는 제외
                filtered_df = df_ncl[df_ncl['상태'] != 'Closed'].copy()
                
                # PR_num 추출 전, 혹시 PR 컬럼이 비어있거나 소실될 경우를 대비한 안전장치
                filtered_df['PR_num'] = filtered_df['PR'].astype(str).str.extract(r'(\d+)')
                
                # CIL_id 기준으로 그룹화하여 PR_num 결합
                result_ncl = filtered_df.groupby('CIL_id')['PR_num'].apply(lambda x: ', '.join(x)).reset_index()
            
            pbar.update(20)
            pbar.close()
            # result_ncl
            # |   CIL_id  |   PR_num   |
            # |-----------|------------|
            # | 1062342.0 | 1287, 1288 |
            return result_ncl
        
        # Phase 1-4 병렬 실행
        with ThreadPoolExecutor(max_workers=4) as executor:
            #future_phase1 = executor.submit(phase_1_pa_extraction)
            future_phase2 = executor.submit(phase_2_cil_extraction)
            future_phase3 = executor.submit(phase_3_baseline_extraction)
            future_phase4 = executor.submit(phase_4_ncl_extraction)
            
            #df_pa = future_phase1.result()
            # df_pa
            #|  source |                  name                  |   pa   |
            #| ------- | -------------------------------------- | ------ |
            #| Tracker | System Functional Risk Analysis Report | 723434 |
            #|                           ...                             |
            #| Category| System Requirements Specification      | 818526 | 


            df_merged, df_items, df_unregistered = future_phase2.result()
            # df_items(첫번째 리턴값)
            #  |                       name               |CIL_address|
            #  |------------------------------------------|-----------|
            #  | Validation Report                        |  1062742  |
            #  | Stakeholder Requirements Analysis        |  1062740  |
            #  | Validation Specification Review Report   |  1062738  |

            # df_merged(두번째 리턴값)
            # |  CIL_ID |    CIL_uri    |             트래커명               | TRACKER_Connected |   TRACKER_uri  | baselineVersion | workItemStatus | 프로세스명 | 관리유형 | PR-ID | PR-ID_url | 저장 규칙 | 버전 규칙 | 문서 이력 기술 규칙 | 상태 규칙 | comment | Status | Revuew_Report_uri |
            # |---------|---------------|-----------------------------------|-------------------|----------------|-----------------|----------------|----------|---------|-------|-----------|---------|----------|-------------------|---------|---------|--------| ----------------- |
            # | 1062742 | /item/1062742 | Validation Report                 |         X         |       None     |       None      |      None      |  VAL.1   | 버전관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654478  |
            # | 1062740 | /item/1062740 | Stakeholder Requirements Analysis |         O         |/tracker/8642282|        ...      |  Audit Closed  |  VAL.1   | 저장관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654222  |

            df2 = future_phase3.result()
            # df2(베이스라인 데이터)
            # | 베이스라인ID |                      트래커                     |    버전종류  |    버전   | 담당자 |            설명          |           시각          | PR-ID | CR-ID |
            # |------------|------------------------------------------------|-------------|----------|-------|--------------------------|------------------------| ------|-------|
            # |   8656437  | [MAN.3]Lifecycle                               | Create Date | 260511.0 | 명노아 | NaN                      | 2026-05-11T10:46:02.959 | NaN  |   NaN |
            # |   8630309  | [MAN.3]Human Effort Management_계획본           | Version Up  | 1.2      | 한태경 | PR~-03                   | 2026-04-28T15:39:03.417 | 3.0  |   NaN |
            # |   8628960  | [HWE.1]Hardware Requirements Specification     | Version Up  | 1.0      | 명노아 | CR~-02, PR~-04, 조치 완료 | 2026-04-24T08:37:27.945 | 4.0  |   2.0 |
            # |   8652713  | [SWE.4]Software Verification-Review Plan Review| Create Date | 260422.0 | 명노아 | PR~-5 조치 완료의 건       | 2026-04-22T15:38:13.914 | 5.0  |   NaN |
            
            result_ncl = future_phase4.result()
            # result_ncl
            # |   CIL_id  |   PR_num   |
            # |-----------|------------|
            # | 1062342.0 | 1287, 1288 |

        # ============================================================================
        # [Phase 5] 데이터 병합(여기까지는 코드비머에서 갖고온 일반 데이터들의 병합)
        # ============================================================================
        clear_console()
        pbar = tqdm(total=100, desc="[Phase 5] 데이터 병합", position=0, leave=True)
        
        pbar.update(40)
        
        # CIL 데이터와 NCL 매칭
        result_ncl['CIL_id_str'] = result_ncl['CIL_id'].astype(float).astype(int).astype(str)
        df_merged['CIL_id_match'] = df_merged['CIL_uri'].str.extract(r'(\d+)') # /item/1062742 => 1062742만 추출
        
        df_merged = pd.merge(
            df_merged,
            result_ncl[['CIL_id_str', 'PR_num']],
            left_on='CIL_id_match',
            right_on='CIL_id_str',
            how='left'
        )
        
        df_merged = df_merged.rename(columns={'PR_num': '관련PR'})
        df_merged = df_merged.drop(columns=['CIL_id_match', 'CIL_id_str'])

        # df_merged("관련 PR"열 추가)
        # |  CIL_ID |    CIL_uri    |             트래커명               | TRACKER_Connected |   TRACKER_uri  | baselineVersion | workItemStatus | 프로세스명 | 관리유형 | PR-ID | PR-ID_url | 저장 규칙 | 버전 규칙 | 문서 이력 기술 규칙 | 상태 규칙 | comment | Status | Revuew_Report_uri |  관련 PR |
        # |---------|---------------|-----------------------------------|-------------------|----------------|-----------------|----------------|----------|---------|-------|-----------|---------|----------|-------------------|---------|---------|--------| ----------------- |----------|
        # | 1062742 | /item/1062742 | Validation Report                 |         X         |       None     |       None      |      None      |  VAL.1   | 버전관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654478  |1287,1288|
        # | 1062740 | /item/1062740 | Stakeholder Requirements Analysis |         O         |/tracker/8642282|        ...      |  Audit Closed  |  VAL.1   | 저장관리 | None  |     None  |   None   |    None  |        None      |   None   |   None   |  Open | /tracker/8654222  | None    |
        df_merged.to_excel(Path(__file__).parent / "B_CM_CIL.xlsx", index=False)
        df_unregistered.to_excel(Path(__file__).parent / "B_Unregistered.xlsx", index=False)
        pbar.update(60)
        pbar.close()
        
        # ============================================================================
        # [Phase 6] 실제 형상 감사를 위한 데이터로 정제 (병렬 처리)
        # ============================================================================
        clear_console()
        pbar = tqdm(total=100, desc="[Phase 6] 최종 감사 리포트 생성", position=0, leave=True)
        
        df2['시각'] = pd.to_datetime(df2['시각'], errors='coerce')
        latest_baselines = df2.sort_values('시각', ascending=False).groupby('트래커').head(1).set_index('트래커').to_dict('index')
        
        pbar.update(10)
        
        # 병렬 처리
        with ThreadPoolExecutor(max_workers=15) as executor:
            futures = [executor.submit(process_row_parallel, i, df_merged, latest_baselines) for i in range(len(df_merged))]
            results = []

            for future in tqdm(as_completed(futures), total=len(futures), desc="[Phase 6-Sub] 병렬 행 처리", position=1, leave=False):
                result = future.result()
                if result:
                    results.append(result)
        
        pbar.update(90)
        pbar.close()
        
        # ============================================================================
        # [최종 정리] 데이터프레임 생성 및 저장
        # ============================================================================
        clear_console()
        pbar = tqdm(total=100, desc="[최종] 결과 정리 및 저장", position=0, leave=True)


        df_result = pd.DataFrame(results)
        pbar.update(50)
        # 버저닝 최근 시각이 숫자로 뜨는 것을 방지
        temp_dt = pd.to_datetime(df_result['버저닝 최근 시각'], errors='coerce')
        df_result['버저닝 최근 시각'] = temp_dt.dt.floor('s').dt.strftime('%Y-%m-%dT%H:%M:%S+09:00').fillna("")
        
        # 엑셀 저장
        df_result.to_excel(Path(__file__).parent / "B_CM_Audit.xlsx", index=False)
        
        pbar.update(50)
        pbar.close()
        
        clear_console()

    except Exception as e:
        clear_console()
        print(f"\n✗ 에러 발생: {str(e)}\n")
        import traceback
        traceback.print_exc()

    finally:
        session.close()

if __name__ == "__main__":
    Audit_Data_Creation(BASE_URL, BASE_URL_V3, USERNAME, PASSWORD, PROJECT_NAME, TRACKER_NAME_CIL, TRACKER_NAME_NCL)