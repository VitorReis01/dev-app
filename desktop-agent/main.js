"use strict";

/**
 * Lookout Desktop Agent – PRODUÇÃO
 *
 * ✔ DeviceId automático (UUID persistido)
 * ✔ Zero input do usuário
 * ✔ Multi-PC garantido
 * ✔ WebSocket com heartbeat
 * ✔ Reconexão automática
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
const AGENT_VERSION = "1.0.4";

// ============================
// DEVICE ID PERSISTENTE
// ============================

const DATA_DIR = app.getPath("userData");
const CONFIG_PATH = path.join(DATA_DIR, "agent-config.json");

function getOrCreateDeviceId() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.deviceId) return cfg.deviceId;
    }
  } catch {}

  const deviceId = "device-" + crypto.randomUUID();
  const cfg = { deviceId, createdAt: new Date().toISOString() };

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

function connectWs() {
  if (ws) {
    try { ws.close(); } catch {}
  }

  ws = new WebSocket(wsUrl());

  ws.on("open", () => {
    startHeartbeat();
    mainWindow?.setTitle("Lookout Agent - conectado");
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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

      ws.send(JSON.stringify({
        type: "consent_response",
        accepted: res.response === 0
      }));

      if (res.response === 0) startStreaming();
      else stopStreaming();
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    stopStreaming();
    mainWindow?.setTitle("Lookout Agent - desconectado");
    reconnectTimer = setTimeout(connectWs, 2000);
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

  ws.send(JSON.stringify({
    type: "screen_frame",
    deviceId: DEVICE_ID,
    jpeg: sources[0].thumbnail.toDataURL("image/jpeg", 0.6),
    ts: Date.now()
  }));
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

app.whenReady().then(() => {
  createWindow();
  connectWs();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});
