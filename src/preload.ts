import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from './shared/api.ts';

const api: Api = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  onState: cb => { ipcRenderer.on('state', (_e, s) => cb(s)); },
  onEffect: cb => { ipcRenderer.on('effect', (_e, effect) => cb(effect)); },
  onNotice: cb => { ipcRenderer.on('notice', (_e, message) => cb(message)); },
  send: cmd => ipcRenderer.send('cmd', cmd),
  exportData: format => ipcRenderer.invoke('data:export', format),
  importData: () => ipcRenderer.invoke('data:import'),
  listSounds: () => ipcRenderer.invoke('sounds:list'),
  readSound: name => ipcRenderer.invoke('sounds:read', name),
  openSoundsDir: () => ipcRenderer.send('sounds:open'),
  toggleMini: () => ipcRenderer.send('mini:toggle'),
  showMain: () => ipcRenderer.send('main:show')
};

contextBridge.exposeInMainWorld('api', api);
