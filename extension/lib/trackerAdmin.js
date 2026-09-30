// codebeamer 트래커 생성(복제)/삭제 - 이름 불일치 화면(popup.js)에서 codebeamer 화면을
// 오가지 않고 바로 처리할 수 있게 한다.
//
// PTC codebeamer REST API(레거시 v2, cb/rest) 문서 기준:
//   - POST {트래커URI}/clone : 지정한 트래커를 템플릿으로 삼아 스키마/필드/권한을 그대로
//     물려받은 새 트래커를 만든다.
//   - DELETE {트래커URI} : 트래커를 삭제한다(codebeamer 쪽에서 휴지통으로 이동 - 서버 설정에
//     따라 관리자가 복구 가능하지만, 이 확장에서 되돌리는 방법은 없다).
// (https://support.ptc.com/help/codebeamer 개발자 가이드 Trackers 문서 참고. 정확한 요청/
// 응답 형식은 codebeamer 버전마다 조금씩 다를 수 있어, 실패하면 codebeamerClient의
// postJson/deleteJson이 서버 응답 본문을 그대로 에러 메시지에 실어 보낸다.)

/**
 * 기존 트래커를 템플릿으로 삼아 새 트래커를 만든다(Item List엔 있는데 대응하는 트래커가
 * 없는 경우용).
 * @param {object} client - createClient()가 반환한 클라이언트
 * @param {object} params
 * @param {string} params.templateTrackerUri - 템플릿으로 쓸 기존 트래커의 uri (예: "/tracker/123")
 * @param {string} params.projectUri - 새 트래커가 속할 프로젝트의 uri (예: "/project/1")
 * @param {string} params.name - 새 트래커 이름
 * @param {string} params.keyName - 새 트래커의 키(짧은 식별자, 예: "TEST")
 * @param {string} [params.description] - 새 트래커 설명(생략 가능)
 * @returns {Promise<object>} 생성된 트래커 정보
 */
export async function cloneTracker(client, { templateTrackerUri, projectUri, name, keyName, description }) {
  const url = `${client.baseUrl}${templateTrackerUri}/clone`;
  const body = { project: projectUri, name, keyName };
  if (description) body.description = description;
  return client.postJson(url, body);
}

/**
 * 트래커를 삭제한다(트래커는 있는데 Item List엔 없는, 즉 더 이상 쓰이지 않는 트래커 정리용).
 * 호출 전 반드시 호출부(popup.js)에서 사용자에게 확인을 받아야 한다 - 되돌릴 수 없는 작업이다.
 * @param {object} client
 * @param {string} trackerUri - 예: "/tracker/123"
 */
export async function deleteTracker(client, trackerUri) {
  const url = `${client.baseUrl}${trackerUri}`;
  return client.deleteJson(url);
}
