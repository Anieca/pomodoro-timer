const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 読み込みが返るまでの仮表示に使う既定値。スキーマと二重管理にしないため main から取る。
  // レンダラはサンドボックス下で preload から shared/ を require できないので IPC で渡す。
  // ウィンドウ描画前の preload 実行時に一度だけなので同期で構わない。
  defaultSettings: ipcRenderer.sendSync('data:defaults'),
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  // 終了時にレンダラ破棄前の書き込み完了を保証するための同期保存(beforeunload 用)。
  saveDataSync: data => ipcRenderer.sendSync('data:save-sync', data),
  // 読み込み時の警告(破損退避/回復/権限エラー)を一度だけ回収する。
  consumeLoadWarning: () => ipcRenderer.invoke('data:consume-warning'),
  // main → レンダラ:正本が変わったときのスナップショット。自分の保存も返ってくる
  // ので、main の正規化で直された値がそのまま画面に反映される。
  onDataSnapshot: cb => ipcRenderer.on('data:snapshot', (_e, snapshot) => cb(snapshot)),
  // 書き出す内容は main が持つ正本なので、レンダラからデータは渡さない。
  exportData: format => ipcRenderer.invoke('data:export', { format }),
  listSounds: () => ipcRenderer.invoke('sounds:list'),
  readSound: name => ipcRenderer.invoke('sounds:read', name),
  openSoundsDir: () => ipcRenderer.invoke('sounds:openDir'),
  focusWindow: () => ipcRenderer.send('win:focus'),
  requestAttention: () => ipcRenderer.send('win:attention'),
  // メインウィンドウ(タイマー本体)→ main へ現在の状態を通知。
  // main は Tray タイトル・Dock バッジ/プログレスバー更新とミニウィンドウ配信に使う。
  pushTimerState: state => ipcRenderer.send('timer:state', state),
  // main → メインウィンドウ:Tray/ミニから来た操作を本体タイマーに反映させる。
  onTimerCommand: cb => ipcRenderer.on('timer:command', (_e, cmd) => cb(cmd)),
  // main → メインウィンドウ:システムがスリープに入る。復帰の補正が届くまで完了判定を止める。
  onPowerSuspend: cb => ipcRenderer.on('power:suspend', () => cb()),
  // main → メインウィンドウ:システムスリープから復帰した。眠っていた区間を実働から除く。
  onPowerResume: cb => ipcRenderer.on('power:resume', (_e, span) => cb(span)),
  // main → ミニウィンドウ:最新のタイマー状態を受け取って描画する。
  onTimerState: cb => ipcRenderer.on('timer:state', (_e, state) => cb(state)),
  // ミニウィンドウ → main:操作要求(main が本体へ転送する)。
  sendUiCommand: cmd => ipcRenderer.send('ui:command', cmd),
  toggleMini: () => ipcRenderer.send('mini:toggle')
});
