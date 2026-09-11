// 원본 프로젝트의 config.py 기본값을 그대로 옮긴 것.
export const BASE_URL = "https://codebeamer.slworld.com/cb/rest";
export const BASE_URL_V3 = "https://codebeamer.slworld.com/cb/api/v3";
// 정식 REST API가 아니라 프로젝트 멤버 화면(cb/project/{key}/members)이 내부적으로 쓰는
// 렌더링용 엔드포인트. 문서화된 API가 아니라서 codebeamer 업데이트로 언제든 깨질 수 있다.
export const PROJ_BASE_URL = "https://codebeamer.slworld.com/cb/proj";
export const CM_ROLE_NAME = "CM";
export const TRACKER_NAME_CIL = "[SUP.8]Configuration Item List";
export const TRACKER_NAME_NCL = "[SUP.9]Non-Conformance List";

// 트래커 자체는 프로젝트에 존재하지만, 원래 Item List(CIL)에 등재되는 대상이 아닌 트래커들.
// "Item List 미등재 산출물" 경고에 이 이름들은 올리지 않는다.
// (Review Report/Audit Report는 보조 트래커라도 Item List에 등재돼 있어야 하는 게 맞다고
// 확인됨 - 여기 넣지 않는다. Configuration Item List는 CIL 트래커 자기 자신이라 예외.)
export const TRACKERS_EXEMPT_FROM_ITEM_LIST = [
  "Non-Conformance List",
  "Change Order",
  "Change Request",
  "Urgent Issue",
  "Configuration Item List",
];

// 트래커/카테고리 이름과 실제 Item List(CIL) 등재명이 표기만 살짝 다른 경우의 별칭 매핑.
// 왼쪽 표기를 오른쪽 표기와 같은 이름으로 취급해서 미등재 오탐을 막는다.
export const TRACKER_NAME_ALIASES = {
  "Kick off Meeting Record": "Kick-off Meeting Record",
};

// 일부 트래커 워크플로우가 표준 영어 상태명 대신 다른 이름(예: 한글 "승인됨")을 쓰는 경우의
// 별칭 매핑. 규칙 엔진은 전부 영어 상태명("Approved" 등)으로 비교하므로, 여기 있는 이름은
// codebeamer에서 값을 읽어올 때 바로 오른쪽(표준 영어명)으로 바꿔서 취급한다.
export const STATUS_NAME_ALIASES = {
  "승인됨": "Approved",
  "열림": "Open",
  "검토중": "In Review",
  "릴리스됨": "Released",
};

// 하나의 Review Report가 자기 이름 문서뿐 아니라 다른 문서까지 같이 검토 대상으로 포함하는
// 경우. 왼쪽 Review Report 이름(" Review Report" 뗀 것)이 오른쪽에 나열된 문서(들)의 리뷰
// 상태/대상 버전까지 같이 커버한다 - 그 문서들은 별도의 자기 이름 Review Report가 없다.
// 오른쪽 문서 이름 뒤에 (AP)/(MCU)/(IC) 같은 한정자가 붙어도, Review Report 쪽에 붙은
// 한정자와 짝을 맞춰 같은 Review Report로 연결된다(둘 다 한정자가 없으면 그대로 연결).
export const REVIEW_REPORT_ADDITIONAL_TARGETS = {
  "Software Architecture Design Specification": ["Software Calibration Data", "Software Configuration Data"],
};

// Item List(CIL)엔 등재돼 있지만, 실제 산출물이 codebeamer 밖(예: Bitbucket의 Source Code)에
// 있어서 애초에 대응하는 codebeamer 트래커가 존재하지 않는 이름들. 이름이 살짝 달라서
// 매칭에 실패한 "미등재"와는 다른 케이스라서 구분해서 관리한다 - 여기 있는 이름은 "미등재"
// 경고 대신, 감사 결과 표에 "직접 확인 필요" 안내로 뜬다(자동으로 판정할 수 없으므로).
export const ITEM_LIST_ENTRIES_WITHOUT_TRACKER = [
  "Source Code",
];
