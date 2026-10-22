// 부서 공용 저장소 서버(server/app.py)와 통신하는 아주 얇은 클라이언트. lib/history.js와
// lib/reviewState.js가 예전엔 chrome.storage.local을 직접 썼는데, 이제 이 서버의 key-value
// 저장소를 쓴다 - 여러 사람이 같은 프로젝트를 감사해도 "지난 감사" 기준이 똑같이 보이게
// 하기 위함이다. codebeamer 호출 자체는 여전히 각자 브라우저가 자기 계정으로 하고, 이 서버는
// 그 결과만 저장/조회할 뿐 codebeamer와는 전혀 통신하지 않는다.
//
// 이 서버는 "있으면 좋은" 비교 기준 저장용이지 감사 자체의 필수 요소가 아니다 - 서버가 아직
// 안 떠 있거나 네트워크 문제가 있어도 감사/반영 자체는 막히면 안 된다(memberRoles.js의
// "판단 불가면 막지 않는다" 원칙과 동일). 그래서 실패하면 콘솔에 경고만 남기고 조용히
// "저장된 게 없다"로 취급한다 - 그 결과 그 프로젝트의 비교 기준(신규/변경 안내, NG 집계 등)이
// 이번 한 번은 부정확할 수 있지만, 감사·반영 자체가 멈추는 것보단 낫다.

import { APP_SERVER_BASE_URL } from "./config.js";

export async function getServerValue(projectName, key) {
  try {
    const resp = await fetch(`${APP_SERVER_BASE_URL}/api/kv/${encodeURIComponent(projectName)}/${key}`);
    if (!resp.ok) throw new Error(`상태 코드 ${resp.status}`);
    const json = await resp.json();
    return json.value;
  } catch (e) {
    console.warn(`[serverClient] ${key} 조회 실패 - 저장된 게 없는 것으로 취급합니다:`, e);
    return null;
  }
}

export async function putServerValue(projectName, key, value) {
  try {
    const resp = await fetch(`${APP_SERVER_BASE_URL}/api/kv/${encodeURIComponent(projectName)}/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!resp.ok) throw new Error(`상태 코드 ${resp.status}`);
  } catch (e) {
    console.warn(`[serverClient] ${key} 저장 실패 - 이번 결과는 공용 저장소에 반영되지 않았습니다:`, e);
  }
}
