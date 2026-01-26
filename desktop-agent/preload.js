// preload.js
const { contextBridge, ipcRenderer, desktopCapturer } = require("electron");

console.log("🔥 PRELOAD NOVO CARREGADO 🔥");

contextBridge.exposeInMainWorld("electronAPI", {
 __buildTag: "LOOKOUT-1.0.2-PRELOAD",


  // config
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  onNeedConfig: (callback) => ipcRenderer.on("need-config", () => callback()),

  // WS conectado
  onWsConnected: (callback) => ipcRenderer.on("ws-connected", () => callback()),

  // consent flow
  onConsentRequest: (callback) =>
    ipcRenderer.on("consent-request", (_event, admin) => callback(admin)),
  sendConsentResponse: (accepted) => ipcRenderer.send("consent-response", accepted),

  onAdminConnected: (callback) =>
    ipcRenderer.on("admin-connected", (_event, admin) => callback(admin)),

  onStartScreenShare: (callback) =>
    ipcRenderer.on("start-screen-share", (_evt, payload) => callback(payload)),

  reportScreenShareStatus: (payload) => ipcRenderer.send("screen-share-status", payload),

  // captura: lista fontes via preload
  getDesktopSources: async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
    });

    if (!sources || sources.length === 0) {
      throw new Error("Nenhuma fonte encontrada no desktopCapturer.");
    }

    return sources.map((s) => ({ id: s.id, name: s.name }));
  },
});
