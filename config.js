// 公開 repo 設定。網頁放在 main 分支（GitHub Pages），資料放在 data 分支。
window.CELLAR_CONFIG = {
  owner: 'comfort527',
  repo: 'wine-cellar',
  dataBranch: 'data',
  dataPath: 'data/wines.json',
  keysPath: 'data/keys.json',
  imageDir: 'images',
  // 檢查別人更新的間隔（秒），只在網頁開著且在前景時
  pollSecondsViewer: 60,
  pollSecondsEditor: 15,
  apiBase: 'https://api.github.com',
  rawBase: 'https://raw.githubusercontent.com',
  // 照片放在 Cloudflare R2（經由照片小程式 cloudflare/photos-worker.js）；留空就照舊放 GitHub
  photoBase: 'https://wine-cellar-photos.comfort527.workers.dev'
};
