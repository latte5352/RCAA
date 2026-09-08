// 툴바 아이콘을 클릭하면 팝업 대신 사이드 패널이 열리도록 설정.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
