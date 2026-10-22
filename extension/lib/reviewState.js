// audit.html 검토 화면(방금 계산한 감사 결과 + 체크박스 선택 + 반영 여부)을 프로젝트별로
// 부서 공용 저장소 서버(server/app.py, lib/serverClient.js)에 저장해둔다. 그래야 검토
// 도중 창을 실수로 닫아도(강제종료, 클릭 실수 등) codebeamer를 처음부터 다시 조회하지
// 않고 그대로 이어보거나, 다른 사람이 봐도 같은 "직전 감사 결과"/형상 감사 보고서를 볼 수 있다
// (이전엔 chrome.storage.local만 써서 그 브라우저에서만 보였다).

import { getServerValue, putServerValue } from "./serverClient.js";

export async function saveReviewState(projectName, state) {
  await putServerValue(projectName, "review_state", state);
}

export async function loadReviewState(projectName) {
  return getServerValue(projectName, "review_state");
}

export async function clearReviewState(projectName) {
  await putServerValue(projectName, "review_state", null);
}
