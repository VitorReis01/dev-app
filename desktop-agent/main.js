"use strict";

/**
 * Lookout Desktop Agent – PRODUÇÃO
 *
 * ✔ DeviceId automático (UUID persistido)  [AGORA GLOBAL POR MÁQUINA]
 * ✔ Zero input do usuário
 * ✔ Multi-PC garantido
 * ✔ WebSocket com heartbeat
 * ✔ Reconexão automática
 * ✔ Anti-múltiplas sessões RDP (LOCK GLOBAL)
 * ✔ Pronto para escala LAN
 */

const { app, BrowserWindow, dialog, desktopCapturer } = require("electron");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ============================
// CONFIG FIXA
// ============================

const BACKEND_HOST = "192.168.1.101";
const BACKEND_PORT = 3001;
const AGENT_VERSION = "1.0.5";

// ============================
// STORAGE GLOBAL (POR MÁQUINA)
// ============================
// Importante: userData é por usuário/sessão. Em RDP vira caos.
// ProgramData é por máquina e acessível em todas as sessões.
const PROGRAM_DATA = process.env.ProgramData || "C:\\ProgramData";
const BASE_DIR = path.join(PROGRAM_DATA, "LOOKOUT");
const CONFIG_PATH = path.join(BASE_DIR, "agent-config.json");
const LOCK_PATH = path.join(BASE_DIR, "agent.lock");

function ensureBaseDir() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  } catch {}
}

// ============================
// LOCK GLOBAL (ANTI-RDP MULTI-SESSION)
// ============================

function processExists(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireGlobalLock() {
  ensureBaseDir();

  // 1) Se existe lock, tenta entender se é órfão (crash)
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const raw = fs.readFileSync(LOCK_PATH, "utf8");
      const info = JSON.parse(raw);
      const ownerPid = Number(info?.pid);

      // Se o PID ainda existe, bloqueia (outro agent já é o dono)
      if (processExists(ownerPid)) {
        return { ok: false, reason: "lock_exists", owner: info };
      }

      // Se não existe, lock órfão: remove e tenta adquirir
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
    } catch {
      // Lock corrompido: tenta remover
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
    }
  }

  // 2) Cria lock exclusivo
  try {
    const fd = fs.openSync(LOCK_PATH, "wx"); // falha se já existir
    const owner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: AGENT_VERSION,
      session: process.env.SESSIONNAME || null,
      username: process.env.USERNAME || null
    };
    fs.writeFileSync(fd, JSON.stringify(owner, null, 2));
    fs.closeSync(fd);
    return { ok: true, owner };
  } catch {
    // Se alguém criou entre o check e o openSync
    try {
      const raw = fs.readFileSync(LOCK_PATH, "utf8");
      return { ok: false, reason: "lock_exists", owner: JSON.parse(raw) };
    } catch {
      return { ok: false, reason: "lock_exists_unknown", owner: null };
    }
  }
}

function releaseGlobalLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const raw = fs.readFileSync(LOCK_PATH, "utf8");
    const info = JSON.parse(raw);
    if (Number(info?.pid) === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {}
}

// ============================
// DEVICE ID PERSISTENTE (GLOBAL)
// ============================

function getOrCreateDeviceId() {
  ensureBaseDir();

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.deviceId) return cfg.deviceId;
    }
  } catch {}

  const deviceId = "device-" + crypto.randomUUID();
  const cfg = {
    deviceId,
    createdAt: new Date().toISOString(),
    version: AGENT_VERSION
  };

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}

  return deviceId;
}

const DEVICE_ID = getOrCreateDeviceId();

// ============================
// UI (mínima, debug)
// ============================

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 220,
    resizable: false,
    show: true,
    webPreferences: {
      contextIsolation: true
    }
  });

  const html = `
    <html>
      <body style="font-family:Arial;padding:16px">
        <h2>Lookout Agent</h2>
        <div>Device ID: <b>${DEVICE_ID}</b></div>
        <div>Versão: ${AGENT_VERSION}</div>
        <div id="st" style="margin-top:10px;padding:10px;border:1px solid #ccc">
          Conectando...
        </div>
      </body>
    </html>
  `;

  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function setStatus(text) {
  try {
    if (!mainWindow) return;
    const safe = String(text).replace(/`/g, "\\`");
    mainWindow.webContents.executeJavaScript(
      `document.getElementById('st').innerText = \`${safe}\`;`,
      true
    );
  } catch {}
}

// ============================
// WEBSOCKET
// ============================

const HEARTBEAT_MS = 5000;
let ws = null;
let heartbeat = null;
let reconnectTimer = null;

function wsUrl() {
  return `ws://${BACKEND_HOST}:${BACKEND_PORT}/?role=agent&deviceId=${encodeURIComponent(
    DEVICE_ID
  )}&v=${AGENT_VERSION}&token=agent`;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWs, 2000);
}

function connectWs() {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {}
  }

  setStatus("Conectando...");
  ws = new WebSocket(wsUrl());

  ws.on("open", () => {
    startHeartbeat();
    mainWindow?.setTitle("Lookout Agent - conectado");
    setStatus("Conectado ✅");
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "pong") return;

    if (msg.type === "consent_request") {
      const res = await dialog.showMessageBox({
        type: "question",
        buttons: ["Permitir", "Recusar"],
        defaultId: 0,
        cancelId: 1,
        title: "Pedido de Suporte",
        message: `Administrador "${msg.admin}" solicitou acesso remoto.`
      });

      ws.send(
        JSON.stringify({
          type: "consent_response",
          accepted: res.response === 0
        })
      );

      if (res.response === 0) startStreaming();
      else stopStreaming();
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    stopStreaming();
    mainWindow?.setTitle("Lookout Agent - desconectado");
    setStatus("Desconectado. Reconectando...");
    scheduleReconnect();
  });

  ws.on("error", () => {
    // Evita crash por erro de rede
    try {
      ws.close();
    } catch {}
  });
}

// ============================
// SCREEN STREAM
// ============================

let streaming = false;

async function sendFrame() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streaming) return;

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 720 }
  });

  if (!sources.length) return;

  ws.send(
    JSON.stringify({
      type: "screen_frame",
      deviceId: DEVICE_ID,
      jpeg: sources[0].thumbnail.toDataURL("image/jpeg", 0.6),
      ts: Date.now()
    })
  );
}

function startStreaming() {
  if (streaming) return;
  streaming = true;

  const loop = async () => {
    if (!streaming) return;
    await sendFrame();
    setTimeout(loop, 150);
  };
  loop();
}

function stopStreaming() {
  streaming = false;
}

// ============================
// APP
// ============================

// Também ajuda dentro da mesma sessão/usuário (não resolve RDP sozinho, mas é bônus)
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  // Não mostra nada — encerra silencioso
  try {
    app.quit();
  } catch {}
}

app.whenReady().then(async () => {
  // 1) LOCK GLOBAL POR MÁQUINA (resolve RDP multi-session)
  const lock = tryAcquireGlobalLock();
  if (!lock.ok) {
    // Não cria janela para não incomodar usuário em outra sessão.
    // Só encerra silenciosamente.
    try {
      app.quit();
    } catch {}
    return;
  }

  // 2) UI + conexão
  createWindow();
  connectWs();
});

app.on("before-quit", () => {
  try {
    stopHeartbeat();
    stopStreaming();
  } catch {}
  releaseGlobalLock();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});
