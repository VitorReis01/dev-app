"use strict";

/**
 * Lookout Desktop Agent – PRODUÇÃO
 *
 * ✔ DeviceId automático (UUID persistido)  [GLOBAL POR MÁQUINA quando possível]
 * ✔ Tenant (Loja) persistido e enviado no WS (CLA1/CLA2/DLA1/DLA2)
 * ✔ Zero input do usuário
 * ✔ Multi-PC garantido
 * ✔ WebSocket com heartbeat
 * ✔ Reconexão automática
 * ✔ Anti-múltiplas sessões (LOCK GLOBAL)
 *
 * ✅ STREAM OTIMIZADO (internet/5G):
 * - Envia JPEG BINÁRIO (Buffer) via WebSocket (sem base64)
 * - Só faz stream quando backend manda "stream-enable"
 * - Para quando backend manda "stream-disable"
 *
 * ✅ CONSENTIMENTO (sessão):
 * - Pede 1x
 * - Enquanto a sessão estiver ativa, não pede novamente
 * - Quando o viewer fecha (stream-disable) ou o app reinicia, volta a pedir
 */

const { app, BrowserWindow, dialog, desktopCapturer, ipcMain } = require("electron");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ============================
// CONFIG FIXA
// ============================
// BACKEND_HOST pode ser IP interno do servidor
// BACKEND_PORT porta do backend (Express + WS)
const BACKEND_HOST = "192.168.1.101";
const BACKEND_PORT = 3001;
const AGENT_VERSION = "1.0.5";

// ============================
// TENANT (LOJA)
// ============================
// Define qual loja este agent pertence.
// Ordem de resolução:
// 1) env LOOKOUT_TENANT (ideal para gerar instaladores diferentes por loja)
// 2) agent-config.json (persistido na máquina)
// 3) fallback (CLA1)
const VALID_TENANTS = new Set(["CLA1", "CLA2", "DLA1", "DLA2"]);
const DEFAULT_TENANT = "CLA1";

function normTenant(t) {
  return String(t || "").trim().toUpperCase();
}

function resolveTenant(candidate) {
  const v = normTenant(candidate);
  if (!v) return DEFAULT_TENANT;
  if (!VALID_TENANTS.has(v)) return DEFAULT_TENANT;
  return v;
}

// ============================
// STORAGE GLOBAL (POR MÁQUINA) - CROSS PLATFORM
// ============================
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
  const forced = String(process.env.LOOKOUT_BASE_DIR || "").trim();
  if (forced) {
    if (ensureDir(forced)) return forced;
  }

  const platform = process.platform;

  if (platform === "win32") {
    const PROGRAM_DATA = process.env.ProgramData || "C:\\ProgramData";
    const dir = path.join(PROGRAM_DATA, "LOOKOUT");
    ensureDir(dir);
    return dir;
  }

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

  if (platform === "darwin") {
    const dir1 = "/Library/Application Support/LOOKOUT";
    if (ensureDir(dir1) && canWrite(dir1)) return dir1;

    const home = process.env.HOME || process.cwd();
    const dir2 = path.join(home, "Library", "Application Support", "LOOKOUT");
    ensureDir(dir2);
    return dir2;
  }

  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const dir = path.join(home, ".lookout");
  ensureDir(dir);
  return dir;
}

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

function tryAcquireGlobalLock(ownerExtra) {
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const raw = fs.readFileSync(LOCK_PATH, "utf8");
      const info = JSON.parse(raw);
      const ownerPid = Number(info?.pid);

      if (processExists(ownerPid)) {
        return { ok: false, reason: "lock_exists", owner: info };
      }

      try {
        fs.unlinkSync(LOCK_PATH);
      } catch { }
    } catch {
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch { }
    }
  }

  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    const owner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: AGENT_VERSION,
      platform: process.platform,
      baseDir: BASE_DIR,
      session: process.env.SESSIONNAME || null,
      username: process.env.USERNAME || null,
      user: process.env.USER || null,
      ...(ownerExtra || {}),
    };
    fs.writeFileSync(fd, JSON.stringify(owner, null, 2));
    fs.closeSync(fd);
    return { ok: true, owner };
  } catch {
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
// CONFIG PERSISTENTE (deviceId + tenant)
// ============================
// Mantém um JSON em disco para:
// - deviceId único por máquina
// - tenant (loja) fixo para aquele agente
function readConfigSafe() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

function writeConfigSafe(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getOrCreateAgentIdentity() {
  const existing = readConfigSafe();

  // deviceId: preserva se já existe; se não existe, cria.
  const deviceIdFromDisk = String(existing?.deviceId || "").trim();
  const deviceId = deviceIdFromDisk || "device-" + crypto.randomUUID();

  // tenant: prioridade env -> disco -> default
  const tenantFromEnv = resolveTenant(process.env.LOOKOUT_TENANT);
  const tenantFromDisk = resolveTenant(existing?.tenant);
  const tenant = tenantFromEnv || tenantFromDisk || DEFAULT_TENANT;

  const cfg = {
    ...(existing || {}),
    deviceId,
    tenant,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    version: AGENT_VERSION,
    platform: process.platform,
    baseDir: BASE_DIR,
  };

  writeConfigSafe(cfg);

  return { deviceId, tenant };
}

const IDENTITY = getOrCreateAgentIdentity();
const DEVICE_ID = IDENTITY.deviceId;
const TENANT = IDENTITY.tenant;

// ============================
// UI (bonita - loadFile + frame custom)
// ============================
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 500,
    resizable: false,
    show: true,
    backgroundColor: "#05070b",
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"), // necessário pro minimizar/fechar
    },
  });

  // carrega o HTML real (assim a imagem eye-cyber.png funciona)
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // injeta valores iniciais no DOM
  mainWindow.webContents.on("did-finish-load", () => {
    setText("deviceId", DEVICE_ID);
    setText("version", AGENT_VERSION);
    setText("tenant", TENANT); // se não existir no HTML, não causa erro
    setText("statusLabel", "CONECTADO");
    setStatus("Conectado ✅");
  });
}

function setText(id, value) {
  try {
    if (!mainWindow) return;
    const safe = String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`");
    mainWindow.webContents.executeJavaScript(
      `(function(){ const el=document.getElementById(${JSON.stringify(id)}); if(el) el.innerText=\`${safe}\`; })();`,
      true
    );
  } catch { }
}

function setStatus(text) {
  setText("st", text);
}

function setMini(id, value) {
  setText(id, value);
}

// IPC dos botões da titlebar custom (preload chama isso)
ipcMain.on("window:minimize", () => {
  try {
    mainWindow?.minimize();
  } catch { }
});

ipcMain.on("window:close", () => {
  try {
    mainWindow?.close();
  } catch { }
});

// ============================
// WEBSOCKET
// ============================
const HEARTBEAT_MS = 5000;
let ws = null;
let heartbeat = null;
let reconnectTimer = null;

function wsUrl() {
  // Inclui tenant para o backend isolar corretamente as lojas.
  return `ws://${BACKEND_HOST}:${BACKEND_PORT}/?role=agent&deviceId=${encodeURIComponent(
    DEVICE_ID
  )}&tenant=${encodeURIComponent(TENANT)}&v=${AGENT_VERSION}&token=agent`;
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

// ============================
// CONSENT + STREAM STATE (sessão)
// ============================
let consentGranted = false; // aceitou nessa sessão
let viewerActive = false; // backend disse stream-enable
let streaming = false;

// evita abrir múltiplos prompts de consent ao mesmo tempo
let consentPromptOpen = false;

// consent automático quando viewer abre (mesmo sem request_remote_access)
async function ensureConsentForViewer() {
  if (consentGranted) return true;
  if (consentPromptOpen) return false;

  consentPromptOpen = true;
  try {
    const res = await dialog.showMessageBox({
      type: "question",
      buttons: ["Permitir", "Recusar"],
      defaultId: 0,
      cancelId: 1,
      title: "Pedido de Visualização",
      message: `Um administrador abriu a visualização da sua tela.`,
      detail: `Deseja permitir o streaming da tela nesta sessão?`,
    });

    const accepted = res.response === 0;

    if (accepted) {
      consentGranted = true;
      setMini("consent", "ACEITO (sessão)");
      setStatus("Consentimento ACEITO ✅ (viewer)");
      return true;
    }

    consentGranted = false;
    setMini("consent", "NÃO");
    setStatus("Consentimento recusado (viewer). Stream continuará parado.");
    stopStreaming();
    return false;
  } finally {
    consentPromptOpen = false;
  }
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
    mainWindow?.setTitle(`Lookout Agent - conectado (${TENANT})`);
    setStatus("Conectado ✅");
  });

  // ws.on("message") pode receber (data, isBinary)
  ws.on("message", async (raw, isBinary) => {
    // se algum dia chegar binário do backend, ignore (protocolo do backend → agent é JSON)
    if (isBinary) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "pong") return;

    // aceita variações com underscore também
    const t = String(msg.type || "");

    const isStreamEnable = t === "stream-enable" || t === "stream_enable";
    const isStreamDisable = t === "stream-disable" || t === "stream_disable";

    // backend abriu viewer (MJPEG)
    if (isStreamEnable) {
      viewerActive = true;
      setMini("viewer", "ABERTO");
      setStatus(`Viewer abriu (${t}) ✅`);

      // se não tem consent ainda, pede automaticamente (1x na sessão)
      if (!consentGranted) {
        const ok = await ensureConsentForViewer();
        if (!ok) return;
      }

      startStreaming();
      return;
    }

    // backend fechou viewer (MJPEG)
    if (isStreamDisable) {
      viewerActive = false;
      setMini("viewer", "nenhum");
      setStatus(`Viewer fechou (${t}). Stream parado.`);

      stopStreaming();

      // se site/viewer fechou, pede consent de novo na próxima vez
      consentGranted = false;
      setMini("consent", "NÃO");
      return;
    }

    // pedido de consentimento (Suporte)
    if (msg.type === "consent_request") {
      // se já aceitou nessa sessão, não pergunta de novo
      if (consentGranted) {
        try {
          ws.send(JSON.stringify({ type: "consent_response", accepted: true }));
        } catch { }
        setStatus(`Auto-consent ✅ (admin: ${msg.admin || "?"})`);

        // só faz stream se viewer estiver ativo
        if (viewerActive) startStreaming();
        return;
      }

      const res = await dialog.showMessageBox({
        type: "question",
        buttons: ["Permitir", "Recusar"],
        defaultId: 0,
        cancelId: 1,
        title: "Pedido de Suporte",
        message: `Administrador "${msg.admin}" solicitou acesso remoto.`,
      });

      const accepted = res.response === 0;

      try {
        ws.send(JSON.stringify({ type: "consent_response", accepted }));
      } catch { }

      if (accepted) {
        consentGranted = true;
        setMini("consent", "ACEITO (sessão)");
        setStatus("Consentimento ACEITO ✅");

        // só faz stream se viewer estiver ativo
        if (viewerActive) startStreaming();
      } else {
        consentGranted = false;
        setMini("consent", "NÃO");
        setStatus("Consentimento recusado.");
        stopStreaming();
      }
      return;
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    stopStreaming();
    mainWindow?.setTitle("Lookout Agent - desconectado");
    setStatus("Desconectado. Reconectando...");

    // ao cair conexão, reseta sessão
    consentGranted = false;
    viewerActive = false;
    consentPromptOpen = false;
    setMini("consent", "NÃO");
    setMini("viewer", "nenhum");
    setMini("stream", "parado");

    scheduleReconnect();
  });

  ws.on("error", () => {
    try {
      ws.close();
    } catch { }
  });
}

// ============================
// SCREEN STREAM (BINÁRIO JPEG)
// ============================
const FPS_MS = 250; // ~4 fps
const THUMB_W = 960;
const THUMB_H = 540;
const JPEG_QUALITY = 45; // 0..100 (Buffer)

async function captureJpegBuffer() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: THUMB_W, height: THUMB_H },
  });

  if (!sources.length) return null;

  // Buffer JPEG direto (sem base64)
  const img = sources[0].thumbnail;
  const buf = img.toJPEG(JPEG_QUALITY);
  return buf && buf.length ? buf : null;
}

async function sendFrameBinary() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!streaming) return;
  if (!viewerActive) return; // gating
  if (!consentGranted) return; // precisa consent

  try {
    const buf = await captureJpegBuffer();
    if (!buf) return;

    // envia binário direto
    ws.send(buf, { binary: true });
  } catch { }
}

function startStreaming() {
  if (streaming) return;
  streaming = true;
  setMini("stream", "rodando ✅");

  const loop = async () => {
    if (!streaming) return;
    await sendFrameBinary();
    setTimeout(loop, FPS_MS);
  };

  loop();
}

function stopStreaming() {
  streaming = false;
  setMini("stream", "parado");
}

// ============================
// APP
// ============================

// Single-instance (mesmo user). Bônus.
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  try {
    app.quit();
  } catch { }
}

app.whenReady().then(async () => {
  // O lock grava tenant também, útil para diagnóstico quando alguém duplicar processo.
  const lock = tryAcquireGlobalLock({ tenant: TENANT, deviceId: DEVICE_ID });
  if (!lock.ok) {
    try {
      app.quit();
    } catch { }
    return;
  }

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
