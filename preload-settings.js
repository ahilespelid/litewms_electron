const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  printers: () => ipcRenderer.invoke("settings:printers"),
  save: (values) => ipcRenderer.invoke("settings:save", values),
  changeCabinet: (value) => ipcRenderer.invoke("settings:change-cabinet", value),
  checkUpdate: () => ipcRenderer.invoke("shell:check-update"),
  getUpdateState: () => ipcRenderer.invoke("shell:get-update-state"),
  onUpdateState: (cb) => ipcRenderer.on("shell:update-state", (_e, value) => cb(value)),
});
