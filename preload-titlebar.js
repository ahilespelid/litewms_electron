const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellBar", {
  minimize: () => ipcRenderer.invoke("shell:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("shell:toggle-maximize"),
  close: () => ipcRenderer.invoke("shell:close"),
  isMaximized: () => ipcRenderer.invoke("shell:is-maximized"),
  openSettings: () => ipcRenderer.invoke("shell:open-settings"),
  onMaxState: (cb) => ipcRenderer.on("shell:max-state", (_e, value) => cb(value)),
  checkUpdate: () => ipcRenderer.invoke("shell:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("shell:download-update"),
  installUpdate: () => ipcRenderer.invoke("shell:install-update"),
  getUpdateState: () => ipcRenderer.invoke("shell:get-update-state"),
  onUpdateState: (cb) => ipcRenderer.on("shell:update-state", (_e, value) => cb(value)),
});
