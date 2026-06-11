const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  exportData: (format, data) => ipcRenderer.invoke('data:export', { format, data }),
  listSounds: () => ipcRenderer.invoke('sounds:list'),
  readSound: name => ipcRenderer.invoke('sounds:read', name),
  focusWindow: () => ipcRenderer.send('win:focus'),
  requestAttention: () => ipcRenderer.send('win:attention')
});
