const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foxdownDesktop', {
  getLoginItem: () => ipcRenderer.invoke('get-login-item'),
  setLoginItem: value => ipcRenderer.invoke('set-login-item', Boolean(value)),
  selectDirectory: defaultPath => ipcRenderer.invoke('select-directory', defaultPath),
  selectFile: defaultPath => ipcRenderer.invoke('select-file', defaultPath),
  getSetupState: () => ipcRenderer.invoke('setup-state'),
  retryStartup: () => ipcRenderer.invoke('setup-retry'),
  onSetupState: callback => ipcRenderer.on('setup-state', (_event, state) => callback(state)),
});
