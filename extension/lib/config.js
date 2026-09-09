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
