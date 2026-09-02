import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
import json
from pathlib import Path


def CIL_to_PA(BASE_URL, USERNAME, PASSWORD, PROJECT_NAME):

    # 세션 재사용으로 커넥션 오버헤드 줄이기
    session = requests.Session()
    session.auth = HTTPBasicAuth(USERNAME, PASSWORD)
    result = session.get(f"{BASE_URL}/projects/page/1").json()
    result = [t for t in result.get('projects', []) if PROJECT_NAME in t.get('name', "")]
    userURI = BASE_URL + result[0]['uri']

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def fetch_tracker_pa(tracker):
        """트래커 개별 아이템 조회 및 PA 추출"""
        tracker_id_uri = tracker.get('uri')
        tracker_name = tracker.get('name')
        tracker_type = tracker.get('type', {}).get('name')

        items_url = f"{BASE_URL}{tracker_id_uri}/items"
        try:
            response = session.get(items_url).json()
            items_data = response.get('items', [])
        except Exception as e:
            print(f"[오류] 트래커 '{tracker_name}' 호출 실패: {e}")
            return None

        result_val = "-"
        if tracker_type == "Document" and len(items_data) == 1: # Document 트래커의 경우, 그 자체가 PA임
            result_val = str(items_data[0].get('id'))
        else:
            pa_list = [str(item.get('id')) for item in items_data if item.get('type', {}).get('name') == 'Primary Attribute'] # 아니면 모든 항목들을 순회하면서 PA인 애들을 찾음
            if pa_list:
                result_val = ", ".join(pa_list)

        if result_val != "-":
            return {"source": "Tracker", "name": tracker_name, "pa": result_val}
        return None

    def fetch_category_pa(category):
        """카테고리 개별 아이템 조회 및 PA 추출"""
        category_id_uri = category.get('uri')
        category_name = category.get('name')

        items_url = f"{BASE_URL}{category_id_uri}/items"
        try:
            response = session.get(items_url).json()
            items_data = response.get('items', [])
        except Exception as e:
            print(f"[오류] 카테고리 '{category_name}' 호출 실패: {e}")
            return None

        result_val = "-"
        pa_list = [str(item.get('id')) for item in items_data if item.get('type', {}).get('name') == 'Primary Attribute'] # 모든 항목들을 순회하면서 PA인 애들을 찾음
        if pa_list:
            result_val = ", ".join(pa_list)

        if result_val != "-":
            return {"source": "Category", "name": category_name, "pa": result_val}
        return None

    collected_data = []
    trackers = session.get(f"{userURI}/trackers").json()
    categories = session.get(f"{userURI}/categories").json()

    MAX_WORKERS = 15  
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        # 태스크 등록
        tracker_futures = [executor.submit(fetch_tracker_pa, t) for t in trackers]
        category_futures = [executor.submit(fetch_category_pa, c) for c in categories]

        # 완료된 순서대로 결과 수집
        for future in as_completed(tracker_futures + category_futures):
            result = future.result()
            if result:  # PA가 존재하는 애들만 추가
                collected_data.append(result)

    # 3. 통합 DataFrame 생성 및 필터링
    df = pd.DataFrame(collected_data)

    df['Process'] = df['name'].str.extract(r'\[(.*?)\]') # [SYS.2]System Functional Risk Analysis Report -> SYS.2 만 추출
    df['name'] = df['name'].apply(lambda x: x.split(']')[-1].strip() if ']' in x else x) # [SYS.2]System Functional Risk Analysis Report -> System Functional Risk Analysis Report 만 추출
    TRACKER_NAME = "[SUP.8]Configuration Item List"
    result = session.get(f"{userURI}/trackers").json()
    result = [item for item in result if item.get('name') == TRACKER_NAME]
    trackerURI = BASE_URL + result[0]['uri']
    result = session.get(f"{trackerURI}/items").json()

    items_list = result.get('items', []) # CIL 아이템 리스트 추출
    extracted_rows = []
    for item in items_list:
        item_id = item.get('id')
        tracker_name = item.get('name', 'N/A')
        extracted_rows.append({
            "name": tracker_name,
            "CIL_address": item_id
        })

    df_CIL = pd.DataFrame(extracted_rows)

    merged_df = pd.merge(df, df_CIL, left_on='name', right_on='name', how='left') # 이때 Tracker랑 CIL 아이템의 이름이 일치해야함(FYI. 공나연 사원)
    merged_df['Status'] = ""
    merged_df.head(5)

    for index, row in merged_df.iterrows():
        # row의 CIL_address가 na이면 continue
        if pd.isna(row['CIL_address']):
            merged_df.at[index, 'Status'] = "Unmatched CIL ID"
            continue

        CIL_id = int(row['CIL_address'])
        tracker_name = row['name']
        
        try:
            pa_id = int(row['pa'])
        except:
            print(f"잘못된 PA ID: {tracker_name} : {row['pa']} (행 인덱스: {index})")
            merged_df.at[index, 'Status'] = "Error: Invalid ID"
            continue
        
        get_url = f"https://codebeamer.slworld.com/cb/rest/v3/items/{CIL_id}"
        item_data = session.get(get_url).json()
        
        existing_subjects = item_data.get('subjects', [])
        new_target = {"id": pa_id, "type": "TrackerItemReference"}
        
        # 중복 체크
        if not any(sub.get('id') == pa_id for sub in existing_subjects):
            existing_subjects.append(new_target)
        else:
            print(f"[{tracker_name}] 이미 연결되어 있어 건너뜁니다.")
            merged_df.at[index, 'Status'] = "Already Connected"
            continue
        
        payload = {
            "name": item_data.get('name'),
            "status": item_data.get('status'),
            "priority": item_data.get('priority'),
            "description": item_data.get('description'),
            "customFields": item_data.get('customFields'),
            "subjects": existing_subjects,
            "endDate": item_data.get('endDate')
        }

        put_response = session.put(get_url, headers={'Content-Type': 'application/json', 'accept': 'application/json'}, data=json.dumps(payload))

        if put_response.status_code == 200:
            print(f"성공: [{tracker_name}] -> ID {pa_id} 연결 완료")
            merged_df.at[index, 'Status'] = "Connected"
        else:
            print(f"실패: [{tracker_name}] 업데이트 오류 -> {put_response.text}")
            merged_df.at[index, 'Status'] = "Failed"

    print("-" * 50)
    print("모든 업데이트 공정이 완료되었습니다.")
    # excel로 방출
    merged_df.to_excel(Path(__file__).parent / "A_CIL↔PA.xlsx", index=False)


if __name__ == "__main__":
    import config

    config.require_credentials()
    CIL_to_PA(
        BASE_URL=config.BASE_URL,
        USERNAME=config.CB_USERNAME,
        PASSWORD=config.CB_PASSWORD,
        PROJECT_NAME=config.CB_PROJECT_NAME,
    )