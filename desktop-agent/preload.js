const { contextBridge, ipcRenderer, desktopCapturer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Recebe solicitação de consentimento do backend
  onConsentRequest: (callback) =>
    ipcRenderer.on("consent-request", (event, admin) => callback(admin)),

  // Envia resposta do usuário (Aceitar/Negar)
  sendConsentResponse: (accepted) =>
    ipcRenderer.send("consent-response", accepted),

  // Recebe evento para iniciar captura de tela
  onStartScreenShare: (callback) =>
    ipcRenderer.on("start-screen-share", callback),

  // Recebe aviso quando um admin se conecta
  onAdminConnected: (callback) =>
    ipcRenderer.on("admin-connected", (event, admin) => callback(admin)),

  // Função que pega o stream da tela
  getScreenStream: async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sources[0].id
        }
      }
    });

    return stream;
  }
});