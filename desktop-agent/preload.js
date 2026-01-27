const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");

contextBridge.exposeInMainWorld("electronAPI", {
  __buildTag: "LOOKOUT-1.0.3-PRELOAD",

  // 👇 ADICIONE ISTO
  getUserDataPath: () => ipcRenderer.invoke("get-user-data-path"),

  // CONFIG
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  onNeedConfig: (callback) => ipcRenderer.on("need-config", () => callback()),

  onWsConnected: (callback) => ipcRenderer.on("ws-connected", () => callback()),

  onConsentRequest: (callback) =>
    ipcRenderer.on("consent-request", (_event, admin) => callback(admin)),
  sendConsentResponse: (accepted) =>
    ipcRenderer.send("consent-response", accepted),

  onAdminConnected: (callback) =>
    ipcRenderer.on("admin-connected", (_event, admin) => callback(admin)),

  onStartScreenShare: (callback) =>
    ipcRenderer.on("start-screen-share", (_evt, payload) => callback(payload)),

  reportScreenShareStatus: (payload) =>
    ipcRenderer.send("screen-share-status", payload),

  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
});
