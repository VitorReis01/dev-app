"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lookout", {
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
});
