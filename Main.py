# 가져오려는 파이썬 파일에서 다음 코드 작성
import importlib
from pathlib import Path
import config
# 파일 이름에서 .py를 뺀 이름으로 모듈 가져오기
Phase1 = importlib.import_module("A_CIL_to_PA")
Phase2 = importlib.import_module("B_Audit_Data_Creation")
Phase3 = importlib.import_module("C_Audit")
Phase4 = importlib.import_module("D_Result_Update")
Phase5 = importlib.import_module("E_PR_Edit")

DEFAULT_FILE = Path(__file__).parent / "B_CM_Audit.xlsx"

if __name__ == "__main__":
    config.require_credentials()
    # 함수 호출
    #Phase1.CIL_to_PA(config.BASE_URL, config.CB_USERNAME, config.CB_PASSWORD, config.CB_PROJECT_NAME)
    Phase2.Audit_Data_Creation(
        config.BASE_URL, config.BASE_URL_V3, config.CB_USERNAME, config.CB_PASSWORD,
        config.CB_PROJECT_NAME, config.TRACKER_NAME_CIL, config.TRACKER_NAME_NCL,
    )
    Phase3.run(str(DEFAULT_FILE))
    Phase4.NG_Update(config.BASE_URL, config.CB_USERNAME, config.CB_PASSWORD)
    Phase5.run(config.CB_USERNAME, config.CB_PASSWORD, config.TRACKER_NAME_CIL)