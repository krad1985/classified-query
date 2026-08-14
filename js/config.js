// 前端設定 - 請勿直接修改此檔案，部署時由建置流程注入
const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbylyLYgDIhBizxpIwpfjiQoYO6cmJ89oM9cDPvtCJFIPiwYiVergCsxJnLQ6mz3VYgWCw/exec',
  // PUBLIC_TOKEN 會在首次載入活動列表時從 GAS 取得，並儲存於 sessionStorage
  // 單位隔離（選填）：固定此查詢頁只能看到該單位的活動
  // 若未設定，可於網址加 ?unit=<id>&unitToken=<token> 指定
  // UNIT: '',
  // UNIT_TOKEN: '',
};
