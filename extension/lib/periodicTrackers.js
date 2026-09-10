// 원본 프로젝트의 tracker_config.json을 그대로 옮긴 것.
// "2.2) 버전규칙준수: 주기적으로 업로드되는 산출물이 지정된 주기 내 Create Date가
// 진행됐는지" 규칙의 대상 트래커 목록. 새 산출물이 추가되면 이 배열만 고치면 된다.

export const PERIODIC_TRACKERS = new Set([
  "Project Weekly Meeting Record", "Schedule Plan(실행본)", "Human Effort Management(실행본)"
]);
