"use strict";

/**
 * Lookout Desktop Agent – PRODUÇÃO
 *
 * ✔ DeviceId automático (UUID persistido)  [GLOBAL POR MÁQUINA quando possível]
 * ✔ Zero input do usuário
 * ✔ Multi-PC garantido
 * ✔ WebSocket com heartbeat
 * ✔ Reconexão automática
 * ✔ Anti-múltiplas sessões (LOCK GLOBAL)
 * ✔ Pronto para escala LAN
 *
 * ✅ FIX CROSS-PLATFORM:
 * - Antes: storage/lock hardcoded em C:\ProgramData\... (Windows-only)
 * - paths por SO + fallback seguro quando global não tiver permissão
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
// STORAGE GLOBAL (POR MÁQUINA) - CROSS PLATFORM
// ============================

/**
 * ✅ Regras:
 * - Windows: C:\ProgramData\LOOKOUT\ (global por máquina)
 * - Linux: tenta /var/lib/lookout/ (global por máquina)
 *   - se sem permissão: fallback para ~/.lookout/ (por usuário, mas não quebra execução)
 * - macOS: tenta /Library/Application Support/LOOKOUT (global por máquina)
 *   - se sem permissão: fallback para ~/Library/Application Support/LOOKOUT (por usuário)
 *
 * Obs: Se quiser forçar path (deploy corporativo),
 * pode setar env LOOKOUT_BASE_DIR=/caminho/custom
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function canWrite(dir) {
  try {
    const p = path.join(dir, ".write_test");
    fs.writeFileSync(p, "ok");
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseDir() {
  // ✅ override manual (deploy corporativo)
  const forced = String(process.env.LOOKOUT_BASE_DIR || "").trim();
  if (forced) {
    if (ensureDir(forced)) return forced;
  }

  const platform = process.platform;

  // Windows (global por máquina)
  if (platform === "win32") {
    const PROGRAM_DATA = process.env.ProgramData || "C:\\ProgramData";
    const dir = path.join(PROGRAM_DATA, "LOOKOUT");
    ensureDir(dir);
    return dir;
  }

  // Linux (tenta global, fallback user)
  if (platform === "linux") {
    const dir1 = "/var/lib/lookout";
    if (ensureDir(dir1) && canWrite(dir1)) return dir1;

    const dir2 = "/var/local/lookout";
    if (ensureDir(dir2) && canWrite(dir2)) return dir2;

    const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
    const dir3 = path.join(home, ".lookout");
    ensureDir(dir3);
    return dir3;
  }

  // macOS (tenta global, fallback user)
  if (platform === "darwin") {
    const dir1 = "/Library/Application Support/LOOKOUT";
    if (ensureDir(dir1) && canWrite(dir1)) return dir1;

    const home = process.env.HOME || process.cwd();
    const dir2 = path.join(home, "Library", "Application Support", "LOOKOUT");
    ensureDir(dir2);
    return dir2;
  }

  // Outros SOs (fallback simples)
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const dir = path.join(home, ".lookout");
  ensureDir(dir);
  return dir;
}

// ✅ Resolvido uma vez (evita inconsistência de paths)
const BASE_DIR = resolveBaseDir();
const CONFIG_PATH = path.join(BASE_DIR, "agent-config.json");
const LOCK_PATH = path.join(BASE_DIR, "agent.lock");

// ============================
// LOCK GLOBAL (ANTI-MULTI-SESSION)
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
      } catch { }
    } catch {
      // Lock corrompido: tenta remover
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch { }
    }
  }

  // 2) Cria lock exclusivo
  try {
    const fd = fs.openSync(LOCK_PATH, "wx"); // falha se já existir
    const owner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: AGENT_VERSION,
      platform: process.platform,
      baseDir: BASE_DIR,

      // Windows
      session: process.env.SESSIONNAME || null,
      username: process.env.USERNAME || null,

      // Linux/mac
      user: process.env.USER || null
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
  } catch { }
}

// ============================
// DEVICE ID PERSISTENTE (GLOBAL QUANDO POSSÍVEL)
// ============================

function getOrCreateDeviceId() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.deviceId) return cfg.deviceId;
    }
  } catch { }

  const deviceId = "device-" + crypto.randomUUID();
  const cfg = {
    deviceId,
    createdAt: new Date().toISOString(),
    version: AGENT_VERSION,
    platform: process.platform,
    baseDir: BASE_DIR
  };

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch { }

  return deviceId;
}

const DEVICE_ID = getOrCreateDeviceId();

// ============================
// UI (mínima, debug)
// ============================

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 240,
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
        <div>BaseDir: <code>${BASE_DIR}</code></div>
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
  } catch { }
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
    } catch { }
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
    } catch { }
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
    thumbnailSize: { width: 960, height: 540 }
  });

  if (!sources.length) return;

  ws.send(
    JSON.stringify({
      type: "frame",
      jpegBase64: sources[0].thumbnail.toDataURL("image/jpeg", 0.45)
    })
  );
}

function startStreaming() {
  if (streaming) return;
  streaming = true;

  const loop = async () => {
    if (!streaming) return;
    await sendFrame();
    setTimeout(loop, 250); // ~4 FPS (internet-friendly)
  };

  loop();
}
// ============================
// APP
// ============================

// ✅ Single-instance (mesmo user). Bônus.
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  try {
    app.quit();
  } catch { }
}

app.whenReady().then(async () => {
  // 1) LOCK GLOBAL
  const lock = tryAcquireGlobalLock();
  if (!lock.ok) {
    try {
      app.quit();
    } catch { }
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
  } catch { }
  releaseGlobalLock();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});
