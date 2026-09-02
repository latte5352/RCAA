// 툴바 아이콘을 클릭하면 팝업 대신 사이드 패널이 열리도록 설정.
// 사이드 패널은 현재 탭 오른쪽에 도킹되어 열리고, 다른 곳을 클릭하거나 탭을 전환해도 닫히지 않는다.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
