const {contextBridge, ipcRenderer} = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, state) => callback(state);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  authStatus: () => ipcRenderer.invoke('desktop:auth-status'),
  signIn: () => ipcRenderer.invoke('desktop:sign-in'),
  cancelSignIn: () => ipcRenderer.invoke('desktop:cancel-sign-in'),
  selectRepository: () => ipcRenderer.invoke('desktop:select-repository'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  runtimeStatus: () => ipcRenderer.invoke('desktop:runtime-status'),
  showDiagnostics: () => ipcRenderer.invoke('desktop:diagnostics'),
  onAuth: subscribe('desktop:auth'),
  onRuntime: subscribe('desktop:runtime'),
}));
