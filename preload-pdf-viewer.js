const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("litewmsPdfViewer", {
  getDocument: () => ipcRenderer.invoke("pdf-viewer:get-document"),
  print: (pageSize) => ipcRenderer.invoke("pdf-viewer:print", pageSize),
  showInFolder: () => ipcRenderer.invoke("pdf-viewer:show-in-folder"),
});
