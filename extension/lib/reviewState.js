// audit.html 검토 화면(방금 계산한 감사 결과 + 체크박스 선택 + 반영 여부)을 프로젝트별로
// chrome.storage.local에 저장해둔다. 그래야 검토 도중 창을 실수로 닫아도(강제종료, 클릭
// 실수 등) codebeamer를 처음부터 다시 조회하지 않고 그대로 이어보거나, 최소한 마지막
// 감사 결과가 무엇이었는지 확인할 수 있다.

function reviewStateKey(projectName) {
  return `review_state_${projectName}`;
}

export async function saveReviewState(projectName, state) {
  await chrome.storage.local.set({ [reviewStateKey(projectName)]: state });
}

export async function loadReviewState(projectName) {
  const key = reviewStateKey(projectName);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

export async function clearReviewState(projectName) {
  await chrome.storage.local.remove(reviewStateKey(projectName));
}
