const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  // 終了時にレンダラ破棄前の書き込み完了を保証するための同期保存(beforeunload 用)。
  saveDataSync: data => ipcRenderer.sendSync('data:save-sync', data),
  // 読み込み時の警告(破損退避/回復/権限エラー)を一度だけ回収する。
  consumeLoadWarning: () => ipcRenderer.invoke('data:consume-warning'),
  exportData: (format, data) => ipcRenderer.invoke('data:export', { format, data }),
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
  // main → ミニウィンドウ:最新のタイマー状態を受け取って描画する。
  onTimerState: cb => ipcRenderer.on('timer:state', (_e, state) => cb(state)),
  // ミニウィンドウ → main:操作要求(main が本体へ転送する)。
  sendUiCommand: cmd => ipcRenderer.send('ui:command', cmd),
  toggleMini: () => ipcRenderer.send('mini:toggle')
});
