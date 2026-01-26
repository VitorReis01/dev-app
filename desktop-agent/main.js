// main.js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const WebSocket = require("ws");
const fs = require("fs");

let mainWindow;
let ws;
let reconnectTimer = null;
let lastAdmin = null;

// =======================
// CONFIG FILE
// =======================
function getConfigPath() {
  return path.join(app.getPath("userData"), "agent-config.json");
}

function readConfigSafe() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);

    if (!cfg?.url || !cfg?.deviceId || !cfg?.token) return null;
    return cfg;
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  const configDir = app.getPath("userData");
  const configPath = getConfigPath();

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        url: String(cfg.url || "").trim(),
        deviceId: String(cfg.deviceId || "").trim(),
        token: String(cfg.token || "").trim(),
      },
      null,
      2
    ),
    "utf8"
  );
}

// =======================
// WINDOW
// =======================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 520,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      devTools: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// =======================
// WS CONNECTION
// =======================
function buildWsUrl(baseUrl, deviceId, token) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const params = new URLSearchParams({
    role: "agent",
    deviceId,
    token,
  });
  return `${cleanBase}/?${params.toString()}`;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 5000);
}

function closeWS() {
  try {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  } catch {}
}

function connectWS() {
  const cfg = readConfigSafe();

  // Se não tem config, não conecta
  if (!cfg) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("need-config");
    }
    return;
  }

  const url = buildWsUrl(cfg.url, cfg.deviceId, cfg.token);
  console.log("[desktop-agent] Conectando em:", url);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("⚠️ Erro ao criar WS:", e.message);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    console.log("✅ Conectado ao servidor WebSocket");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ws-connected");
    }
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "consent_request") {
      lastAdmin = msg.admin || null;
      console.log("[desktop-agent] consent_request recebido. admin=", lastAdmin);
      mainWindow?.webContents?.send("consent-request", lastAdmin);
    }

    if (msg.type === "admin_connected") {
      lastAdmin = msg.admin || lastAdmin;
      console.log("[desktop-agent] admin_connected:", lastAdmin);
      mainWindow?.webContents?.send("admin-connected", lastAdmin);
    }
  });

  ws.on("close", (code) => {
    console.log(`🔌 Conexão perdida (code=${code}). Tentando reconectar em 5s...`);
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("⚠️ Erro WS:", err.message);
    scheduleReconnect();
  });
}

// =======================
// IPC - config + consent + status
// =======================
ipcMain.handle("get-config", async () => {
  return readConfigSafe(); // pode retornar null
});

ipcMain.handle("save-config", async (_event, cfg) => {
  // validação mínima
  const url = String(cfg?.url || "").trim();
  const deviceId = String(cfg?.deviceId || "").trim();
  const token = String(cfg?.token || "").trim();

  if (!url || !deviceId || !token) {
    return { ok: false, error: "Preencha URL, Device ID e Token." };
  }

  writeConfig({ url, deviceId, token });

  // reconecta
  closeWS();
  connectWS();

  return { ok: true };
});

ipcMain.on("consent-response", async (_event, accepted) => {
  console.log("[desktop-agent] consent-response:", accepted);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "consent_response",
        accepted: !!accepted,
        admin: lastAdmin || undefined,
      })
    );
  } else {
    console.warn("[desktop-agent] WS não está OPEN; não consegui enviar consent_response");
  }

  if (accepted && mainWindow && !mainWindow.isDestroyed()) {
    console.log("[desktop-agent] Enviando start-screen-share para o renderer...");
    mainWindow.webContents.send("start-screen-share", { ts: Date.now() });
  }
});

ipcMain.on("screen-share-status", (_event, payload) => {
  if (!payload) return;
  if (payload.ok) console.log("🟢 Screen share OK:", payload);
  else console.error("🔴 Screen share FAIL:", payload);
});

// =======================
// APP
// =======================
app.whenReady().then(() => {
  createWindow();
  connectWS();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
