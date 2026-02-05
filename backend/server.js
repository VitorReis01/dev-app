"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.set("etag", false);

// ============================
// LOGS (memória - ring buffer)
// ============================
const MAX_LOGS = 500;
const logs = []; // { ts, level, msg, meta }

function addLog(level, msg, meta) {
  const entry = {
    ts: Date.now(),
    level: String(level || "INFO"),
    msg: String(msg || ""),
    meta: meta ?? null,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  // também vai pro console (ajuda no NSSM/serviço)
  try {
    console.log(
      `[${new Date(entry.ts).toISOString()}] ${entry.level}: ${entry.msg}`,
      entry.meta ?? ""
    );
  } catch {}
}

// ============================
// API GUARD: /api nunca pode cair no SPA fallback
// ============================
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ============================
// HTTP LOG (somente /api)
// ============================
app.use((req, _res, next) => {
  if (req.path && String(req.path).startsWith("/api/")) {
    addLog("INFO", `HTTP ${req.method} ${req.path}`, { ip: req.ip });
  }
  next();
});

// ✅ Mantém compatível com seu setup atual,
// mas permite trocar sem refatorar depois (via variável de ambiente).
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const PORT = Number(process.env.PORT || 3001);

// ============================
// Persistência (data dir)
// ============================
const DATA_DIR = path.join(__dirname, "data");

// ============================
// Persistência (aliases)
// ============================
const ALIASES_PATH = path.join(DATA_DIR, "device-aliases.json");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function loadJsonSafe(filePath, fallback) {
  ensureDataDir();
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJsonSafe(filePath, obj) {
  ensureDataDir();
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

let deviceAliases = loadJsonSafe(ALIASES_PATH, {});

// ============================
// Compliance persistence
// ============================
const COMPLIANCE_EVENTS_PATH = path.join(DATA_DIR, "compliance-events.json");
let complianceEvents = loadJsonSafe(COMPLIANCE_EVENTS_PATH, []);
if (!Array.isArray(complianceEvents)) complianceEvents = [];

const complianceByDevice = new Map();

function recomputeComplianceAgg() {
  complianceByDevice.clear();
  for (const ev of complianceEvents) {
    const id = String(ev?.deviceId || "").trim();
    if (!id) continue;

    const prev = complianceByDevice.get(id) || {
      count: 0,
      lastAt: 0,
      lastSeverity: null,
    };

    prev.count += 1;
    if (Number(ev?.timestamp || 0) >= prev.lastAt) {
      prev.lastAt = Number(ev?.timestamp || 0);
      prev.lastSeverity = ev?.severity ?? prev.lastSeverity;
    }

    complianceByDevice.set(id, prev);
  }
}
recomputeComplianceAgg();

function getComplianceState(deviceId) {
  const agg = complianceByDevice.get(String(deviceId || "").trim());
  if (!agg) {
    return {
      complianceFlag: false,
      complianceCount: 0,
      complianceLastAt: null,
      complianceLastSeverity: null,
    };
  }
  return {
    complianceFlag: agg.count > 0,
    complianceCount: agg.count,
    complianceLastAt: agg.lastAt || null,
    complianceLastSeverity: agg.lastSeverity || null,
  };
}

// ============================
// Admin users (seed)
// ============================
const adminsSeed = [
  {
    id: 1,
    username: "admin",
    passwordHash: bcrypt.hashSync("@ims067!", 10),
  },
];

// ============================
// In-memory
// ============================
const devices = []; // { id, connected, lastSeen, agentVersion }
const wsAgentsByDeviceId = new Map();

// ✅ Agora pode guardar:
// - string base64 / dataURL (modo antigo)
// - OU Buffer (modo novo binário)
const lastFrameByDevice = Object.create(null);

// throttle p/ frames
const lastFrameSentAtByDevice = Object.create(null);
const MIN_FRAME_INTERVAL_MS = 250; // 4fps máximo

const PRESENCE_TTL_MS = 15000;

// ✅ viewers MJPEG por device (para gating do stream)
const mjpegViewersByDevice = Object.create(null);

// ============================
// Helpers
// ============================
function nowMs() {
  return Date.now();
}

function normDeviceId(id) {
  return String(id || "").trim();
}

function findDevice(id) {
  const norm = normDeviceId(id);
  return devices.find((d) => d.id === norm);
}

function upsertDevice(id) {
  const deviceId = normDeviceId(id);
  let d = findDevice(deviceId);
  if (!d) {
    d = { id: deviceId, connected: false, lastSeen: null, agentVersion: null };
    devices.push(d);
  }
  return d;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function broadcastToAdmins(obj) {
  wss.clients.forEach((c) => {
    if (c.isAdmin && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(obj));
    }
  });
}

function stripDataUrlToBase64(maybeDataUrl) {
  const s = String(maybeDataUrl || "");
  const m = s.match(/^data:(image\/\w+);base64,(.*)$/);
  if (m) return { mime: m[1], base64: m[2], isDataUrl: true, raw: s };
  return { mime: "image/jpeg", base64: s, isDataUrl: false, raw: s };
}

function isBufferLike(v) {
  return Buffer.isBuffer(v);
}

function getAgentWs(deviceId) {
  const id = normDeviceId(deviceId);
  const ws = wsAgentsByDeviceId.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  return null;
}

function incMjpegViewer(deviceId) {
  const id = normDeviceId(deviceId);
  const n = Number(mjpegViewersByDevice[id] || 0) + 1;
  mjpegViewersByDevice[id] = n;
  return n;
}

function decMjpegViewer(deviceId) {
  const id = normDeviceId(deviceId);
  const n = Math.max(0, Number(mjpegViewersByDevice[id] || 0) - 1);
  mjpegViewersByDevice[id] = n;
  return n;
}

// ✅ compat: envia os 2 nomes (hífen e underscore)
function sendStreamEnable(agentWs, deviceId) {
  if (!agentWs) return;
  safeSend(agentWs, { type: "stream-enable" });
  safeSend(agentWs, { type: "stream_enable" });
  addLog("INFO", "stream enable enviado (compat)", { deviceId });
}

function sendStreamDisable(agentWs, deviceId) {
  if (!agentWs) return;
  safeSend(agentWs, { type: "stream-disable" });
  safeSend(agentWs, { type: "stream_disable" });
  addLog("INFO", "stream disable enviado (compat)", { deviceId });
}

// ============================
// ✅ ADMIN CONSOLE (React build) (ANTES do fallback)
// ============================
const ADMIN_BUILD_DIR = path.join(__dirname, "..", "admin-console", "build");
const ADMIN_INDEX_HTML = path.join(ADMIN_BUILD_DIR, "index.html");

if (fs.existsSync(ADMIN_BUILD_DIR)) {
  addLog("INFO", "Admin Console build detectado", { dir: ADMIN_BUILD_DIR });
  app.use(express.static(ADMIN_BUILD_DIR));
} else {
  addLog("ERROR", "Admin Console build NÃO encontrado", { dir: ADMIN_BUILD_DIR });
}

// ============================
// ✅ Health check (sem auth)
// ============================
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============================
// Auth
// ============================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const admin = adminsSeed.find((a) => a.username === username);

  if (!admin || !bcrypt.compareSync(String(password || ""), admin.passwordHash)) {
    addLog("WARN", "Login inválido", { username: String(username || "") });
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, {
    expiresIn: "1h",
  });

  addLog("INFO", "Login OK", { username: admin.username });
  res.json({ token, user: { id: admin.id, username: admin.username } });
});

function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Token necessário" });

  try {
    req.admin = jwt.verify(auth.replace("Bearer ", ""), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return "";
}

// aceita: Authorization: Bearer ...  OU  ?token=...
function authenticateAdminFlex(req, res, next) {
  const tokenFromHeader = getBearerToken(req);
  const tokenFromQuery = String(req.query?.token || "").trim();

  const token = tokenFromHeader || tokenFromQuery;
  if (!token) return res.status(401).json({ error: "Token necessário" });

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ============================
// REST
// ============================
app.get("/api/devices", authenticateAdmin, (_req, res) => {
  const out = devices.map((d) => {
    const comp = getComplianceState(d.id);
    const connected = !!d.connected;
    return {
      id: d.id,
      deviceId: d.id,
      name: d.id,
      connected,
      online: connected,
      lastSeen: d.lastSeen,
      agentVersion: d.agentVersion,
      ...comp,
    };
  });
  res.json(out);
});

app.get("/api/logs", authenticateAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(logs);
});

// ✅ rota única do frame (1 imagem JPEG)
app.get("/api/devices/:deviceId/frame", authenticateAdminFlex, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);
  const frameRaw = lastFrameByDevice[deviceId];

  if (!frameRaw) return res.status(404).send("No frame");

  if (isBufferLike(frameRaw)) {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.end(frameRaw);
  }

  const info = stripDataUrlToBase64(frameRaw);

  try {
    const buf = Buffer.from(info.base64, "base64");
    res.setHeader("Content-Type", info.mime || "image/jpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.end(buf);
  } catch {
    return res.status(500).send("Invalid frame format");
  }
});

// ✅ MJPEG (stream estilo vídeo) + gating (enable/disable no agent)
app.get("/api/devices/:deviceId/mjpeg", authenticateAdminFlex, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);

  // LOG ÚTIL (pra provar que o request chegou no Node)
  addLog("INFO", "MJPEG endpoint hit", {
    deviceId,
    hasToken: !!String(req.query?.token || ""),
    user: req.admin?.username || null,
  });

  const viewers = incMjpegViewer(deviceId);

  if (viewers === 1) {
    const agentWs = getAgentWs(deviceId);
    if (agentWs) {
      // ✅ compat total: manda os dois
      sendStreamEnable(agentWs, deviceId);
    } else {
      addLog("WARN", "MJPEG viewer abriu mas agent offline", { deviceId });
    }
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
  });

  let alive = true;

  const intervalMs = 250; // 4fps
  const timer = setInterval(() => {
    if (!alive) return;

    const frameRaw = lastFrameByDevice[deviceId];
    if (!frameRaw) return;

    let buf;
    let mime = "image/jpeg";

    if (isBufferLike(frameRaw)) {
      buf = frameRaw;
    } else {
      const info = stripDataUrlToBase64(frameRaw);
      mime = info.mime || "image/jpeg";
      try {
        buf = Buffer.from(info.base64, "base64");
      } catch {
        return;
      }
    }

    res.write(`--frame\r\n`);
    res.write(`Content-Type: ${mime}\r\n`);
    res.write(`Content-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write(`\r\n`);
  }, intervalMs);

  req.on("close", () => {
    alive = false;
    clearInterval(timer);
    try {
      res.end();
    } catch {}

    const left = decMjpegViewer(deviceId);

    if (left === 0) {
      const agentWs = getAgentWs(deviceId);
      if (agentWs) {
        // ✅ compat total: manda os dois
        sendStreamDisable(agentWs, deviceId);
      }
    }
  });
});

// aliases
app.get("/api/device-aliases", authenticateAdmin, (_req, res) => {
  res.json(deviceAliases);
});

app.put("/api/device-aliases/:deviceId", authenticateAdmin, (req, res) => {
  const id = normDeviceId(req.params.deviceId);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";

  if (!id) return res.status(400).json({ error: "deviceId inválido" });

  deviceAliases[id] = { label, updatedAt: new Date().toISOString() };
  saveJsonSafe(ALIASES_PATH, deviceAliases);

  res.json({ ok: true, deviceId: id, ...deviceAliases[id] });
});

// compliance events
app.get("/api/compliance/events", authenticateAdmin, (req, res) => {
  const filterId = String(req.query?.deviceId || "").trim();
  const out = filterId
    ? complianceEvents.filter((e) => String(e?.deviceId || "").trim() === filterId)
    : complianceEvents;

  res.json([...out].sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)));
});

// ✅ API 404 JSON
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    method: req.method,
    path: req.originalUrl,
  });
});

// ✅ SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => {
  if (!fs.existsSync(ADMIN_INDEX_HTML)) {
    return res.status(404).send("Admin Console build not found");
  }
  res.sendFile(ADMIN_INDEX_HTML);
});

// ============================
// Presence TTL cleanup
// ============================
setInterval(() => {
  const t = nowMs();
  for (const d of devices) {
    if (!d.connected) continue;
    const last = Number(d.lastSeen || 0);
    if (last && t - last > PRESENCE_TTL_MS) {
      d.connected = false;

      addLog("WARN", "Presence TTL: marcando device offline", { deviceId: d.id });

      broadcastToAdmins({
        type: "device_presence",
        deviceId: d.id,
        online: false,
        lastSeen: t,
      });
    }
  }
}, 3000).unref?.();

// ============================
// WebSocket
// ============================
wss.on("connection", (ws, req) => {
  const url = String(req.url || "");

  // ✅ CORREÇÃO: parse robusto do querystring
  const qs = url.includes("?") ? url.split("?")[1] : "";
  const params = new URLSearchParams(qs);

  const role = params.get("role");
  const deviceId = normDeviceId(params.get("deviceId"));
  const token = params.get("token");
  const agentVersion = String(params.get("v") || "").trim() || null;

  addLog("INFO", "WS connection", {
    ip: req.socket?.remoteAddress,
    url,
    role,
    deviceId: deviceId || null,
    v: agentVersion,
  });

  // ✅ CORREÇÃO: fecha conexão se role inválido
  if (role !== "admin" && role !== "agent") {
    addLog("WARN", "WS role inválido - fechando", { role, ip: req.socket?.remoteAddress });
    return ws.close(1008, "invalid role");
  }

  if (role === "admin") {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      ws.isAdmin = true;
      ws.adminUser = decoded.username;

      addLog("INFO", "Admin conectado", { username: decoded.username });

      safeSend(ws, { type: "devices_snapshot", devices: devices.map((d) => ({ ...d })) });
    } catch {
      addLog("ERROR", "Admin WS token inválido", { ip: req.socket?.remoteAddress });
      return ws.close(1008, "invalid admin token");
    }
  }

  // ✅ CORREÇÃO: agent sem deviceId -> fecha
  if (role === "agent" && !deviceId) {
    addLog("WARN", "Agent conectou sem deviceId - fechando", { ip: req.socket?.remoteAddress });
    return ws.close(1008, "missing deviceId");
  }

  if (role === "agent" && deviceId) {
    const d = upsertDevice(deviceId);
    d.connected = true;
    d.lastSeen = nowMs();
    if (agentVersion) d.agentVersion = agentVersion;

    ws.isAgent = true;
    ws.deviceId = deviceId;

    wsAgentsByDeviceId.set(deviceId, ws);

    addLog("INFO", "Agent conectado", { deviceId, agentVersion: d.agentVersion });

    broadcastToAdmins({
      type: "device_presence",
      deviceId,
      online: true,
      lastSeen: d.lastSeen,
      agentVersion: d.agentVersion,
    });
  }

  ws.on("message", (raw, isBinary) => {
    if (ws.isAgent && isBinary) {
      const id = ws.deviceId;

      const d = upsertDevice(id);
      d.lastSeen = nowMs();

      const lastAt = Number(lastFrameSentAtByDevice[id] || 0);
      const t = nowMs();
      if (t - lastAt < MIN_FRAME_INTERVAL_MS) return;
      lastFrameSentAtByDevice[id] = t;

      lastFrameByDevice[id] = Buffer.from(raw);

      addLog("INFO", "frame_received_binary", {
        deviceId: id,
        bytes: raw?.length || 0,
      });

      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      addLog("WARN", "WS mensagem não-JSON", { size: String(raw || "").length });
      return;
    }

    addLog("INFO", "WS message", {
      isAdmin: !!ws.isAdmin,
      isAgent: !!ws.isAgent,
      deviceId: ws.deviceId || null,
      type: msg?.type || null,
    });

    if (msg?.type === "ping") {
      if (ws.isAgent && ws.deviceId) {
        const d = upsertDevice(ws.deviceId);
        d.lastSeen = nowMs();
      }
      safeSend(ws, { type: "pong" });
      return;
    }

    if (ws.isAdmin && msg?.type === "request_remote_access") {
      const targetId = normDeviceId(msg.deviceId);
      const agentWs = wsAgentsByDeviceId.get(targetId);

      addLog("INFO", "request_remote_access", {
        admin: ws.adminUser,
        deviceId: targetId,
        agentOnline: !!agentWs && agentWs.readyState === WebSocket.OPEN,
      });

      if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
        safeSend(ws, {
          type: "consent_response",
          deviceId: targetId,
          accepted: false,
          reason: "agent_offline",
        });
        return;
      }

      safeSend(agentWs, { type: "consent_request", admin: ws.adminUser });
      safeSend(ws, { type: "consent_status", deviceId: targetId, status: "sent_to_agent" });
      return;
    }

    if (ws.isAgent && msg?.type === "consent_response") {
      const id = ws.deviceId;
      const accepted = !!msg.accepted;

      addLog("INFO", "consent_response", { deviceId: id, accepted });

      broadcastToAdmins({ type: "consent_response", deviceId: id, accepted });
      return;
    }

    if (ws.isAgent && (msg?.type === "frame" || msg?.type === "screen_frame")) {
      const id = ws.deviceId;

      const payload =
        typeof msg.jpegBase64 === "string"
          ? msg.jpegBase64
          : typeof msg.jpeg === "string"
          ? msg.jpeg
          : "";

      if (!payload) return;

      const d = upsertDevice(id);
      d.lastSeen = nowMs();

      const lastAt = Number(lastFrameSentAtByDevice[id] || 0);
      const t = nowMs();
      if (t - lastAt < MIN_FRAME_INTERVAL_MS) return;
      lastFrameSentAtByDevice[id] = t;

      lastFrameByDevice[id] = payload;

      addLog("INFO", "frame_received_json", {
        deviceId: id,
        len: payload.length,
        isDataUrl: payload.startsWith("data:"),
      });

      return;
    }
  });

  ws.on("close", (code, reason) => {
    addLog("INFO", "WS close", {
      code,
      reason: reason ? reason.toString() : "",
      isAgent: !!ws.isAgent,
      isAdmin: !!ws.isAdmin,
      deviceId: ws.deviceId || null,
    });

    if (ws.isAgent && ws.deviceId) {
      const d = findDevice(ws.deviceId);
      if (d) d.connected = false;

      wsAgentsByDeviceId.delete(ws.deviceId);
      mjpegViewersByDevice[ws.deviceId] = 0;

      broadcastToAdmins({
        type: "device_presence",
        deviceId: ws.deviceId,
        online: false,
        lastSeen: nowMs(),
      });
    }
  });

  ws.on("error", (e) => {
    addLog("ERROR", "WS error", {
      isAgent: !!ws.isAgent,
      isAdmin: !!ws.isAdmin,
      deviceId: ws.deviceId || null,
      err: String(e?.message || e),
    });
  });
});

// ============================
// Start
// ============================
server.listen(PORT, "0.0.0.0", () => {
  addLog("INFO", "Backend rodando", { port: PORT });
});
