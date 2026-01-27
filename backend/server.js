"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const JWT_SECRET = "supersecretkey";

// ============================
// In-memory data (MVP)
// ============================
const adminsSeed = [
  { id: 1, username: "admin", passwordHash: bcrypt.hashSync("admin123", 10) },
];

// ✅ Devices em memória (agora com auto-register)
// Campo canônico: connected (bool)
// Campo compat front: online (alias em REST)
const devices = [
  { id: "device1", name: "PC do João", user: "João", connected: false },
  { id: "device2", name: "Device 2", user: "User 2", connected: false },
  // Você pode manter esse aqui ou remover: com auto-register não é obrigatório
  { id: "device-user01", name: "User 01", user: "User01", connected: false },
];

const logs = [];

// WS sessions
const wsAgentsByDeviceId = new Map(); // deviceId -> ws
// last frame por dispositivo (dataURL jpeg)
const lastFrameByDevice = {}; // { [deviceId]: "data:image/jpeg;base64,..." }

// throttle por device
const lastFrameSentAtByDevice = {}; // { [deviceId]: number(ms) }
const MIN_FRAME_INTERVAL_MS = 120; // ~8 fps

// Presence TTL (anti-zumbi)
const PRESENCE_TTL_MS = 15_000;
const HEARTBEAT_TYPE = "ping"; // msg.type esperado do agent (JSON)

// ============================
// Helpers
// ============================
function nowMs() {
  return Date.now();
}

function normDeviceId(id) {
  return String(id || "").trim();
}

function findDevice(deviceId) {
  return devices.find((d) => d.id === deviceId);
}

function toDeviceDTO(d) {
  return {
    id: d.id,
    name: d.name,
    user: d.user,
    connected: !!d.connected,
    online: !!d.connected, // alias para front
    lastSeen: d.lastSeen,
    agentVersion: d.agentVersion,
  };
}

function safeSend(ws, payloadObj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payloadObj));
  return true;
}

function broadcastToAdmins(payloadObj) {
  wss.clients.forEach((client) => {
    if (client.isAdmin && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payloadObj));
    }
  });
}

function emitPresence(deviceId, online, device) {
  broadcastToAdmins({
    type: "device_presence",
    deviceId,
    online: !!online,
    lastSeen: device?.lastSeen ?? null,
    agentVersion: device?.agentVersion ?? null,
    ts: nowMs(),
  });
}

// ============================
// Auth
// ============================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const admin = adminsSeed.find((a) => a.username === username);

  if (!admin || !bcrypt.compareSync(String(password || ""), admin.passwordHash)) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token, user: { id: admin.id, username: admin.username } });
});

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Token necessário" });

  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

// ============================
// REST
// ============================
app.get("/api/devices", authenticateAdmin, (req, res) => {
  // retorna DTO com alias online
  res.json(devices.map(toDeviceDTO));
});

app.get("/api/logs", authenticateAdmin, (req, res) => {
  res.json(logs);
});

// endpoint HTTP pra buscar a tela (fallback / debug)
app.get("/api/devices/:id/frame", (req, res) => {
  const deviceId = normDeviceId(req.params.id);
  const jpeg = lastFrameByDevice[deviceId];
  if (!jpeg) return res.status(404).send("no frame");

  const base64 = String(jpeg).split(",")[1];
  if (!base64) return res.status(500).send("invalid frame");

  const buf = Buffer.from(base64, "base64");
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(buf);
});

// ============================
// WebSocket
// ============================
function parseQuery(reqUrl) {
  const raw = reqUrl || "";
  const qs = raw.startsWith("/?") ? raw.slice(2) : raw.replace("/", "");
  return new URLSearchParams(qs);
}

function verifyAdminToken(token) {
  if (!token) throw new Error("missing token");
  return jwt.verify(token, JWT_SECRET);
}

function sendDevicesSnapshot(ws) {
  safeSend(ws, {
    type: "devices_snapshot",
    devices: devices.map((d) => ({
      deviceId: d.id,
      online: !!d.connected,
      connected: !!d.connected,
      lastSeen: d.lastSeen,
      agentVersion: d.agentVersion,
    })),
    ts: nowMs(),
  });
}

function handleAgent(ws, deviceId, params) {
  // ✅ AUTO-REGISTER: se o device não existir, cria na hora
  let d = findDevice(deviceId);
  if (!d) {
    d = {
      id: deviceId,
      name: deviceId,
      user: "unknown",
      connected: false,
      lastSeen: null,
      agentVersion: null,
    };
    devices.push(d);
    console.log(`🆕 Registrando novo dispositivo automaticamente: ${deviceId}`);
  }

  // meta: versão do agent (opcional por query ?v=1.0.3)
  const agentVersion = params.get("v") || null;

  d.connected = true;
  d.lastSeen = nowMs();
  if (agentVersion) d.agentVersion = agentVersion;

  wsAgentsByDeviceId.set(deviceId, ws);

  ws.isAgent = true;
  ws.deviceId = deviceId;

  console.log(`✅ Dispositivo ${deviceId} conectado (agent)`);

  // avisa admins imediatamente
  emitPresence(deviceId, true, d);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // Heartbeat do agent (presença)
    if (data?.type === HEARTBEAT_TYPE) {
      const dev = findDevice(deviceId);
      if (dev) dev.lastSeen = nowMs();
      safeSend(ws, { type: "pong", ts: nowMs() });
      return;
    }

    // ✅ CONSENT
    if (data.type === "consent_response") {
      logs.push({
        deviceId,
        action: "consent_response",
        accepted: !!data.accepted,
        timestamp: new Date(),
      });

      broadcastToAdmins({
        type: "consent_response",
        deviceId,
        accepted: !!data.accepted,
      });

      return;
    }

    // ✅ REALTIME: FRAME -> salva e repassa pros ADMINS
    if (data.type === "screen_frame") {
      if (data.deviceId && typeof data.jpeg === "string") {
        const fid = normDeviceId(data.deviceId);

        // salva último frame (para endpoint HTTP)
        lastFrameByDevice[fid] = data.jpeg;

        // throttle por device
        const now = nowMs();
        const last = lastFrameSentAtByDevice[fid] || 0;
        if (now - last < MIN_FRAME_INTERVAL_MS) return;
        lastFrameSentAtByDevice[fid] = now;

        broadcastToAdmins({
          type: "screen_frame",
          deviceId: fid,
          jpeg: data.jpeg,
          ts: data.ts || now,
        });
      }
      return;
    }
  });

  ws.on("close", (code) => {
    const current = wsAgentsByDeviceId.get(deviceId);
    if (current === ws) {
      wsAgentsByDeviceId.delete(deviceId);
    }

    const dev = findDevice(deviceId);
    if (dev) dev.connected = false;

    console.log(`🔌 Dispositivo ${deviceId} desconectado (code=${code})`);

    if (dev) emitPresence(deviceId, false, dev);
  });

  ws.on("error", (err) => {
    console.log(`⚠️ WS agent error (${deviceId}):`, err.message);
  });
}

function handleAdmin(ws, token) {
  let decoded;
  try {
    decoded = verifyAdminToken(token);
  } catch {
    return ws.close(1008, "invalid admin token");
  }

  ws.isAdmin = true;
  ws.adminId = decoded.id;
  ws.adminUser = decoded.username;

  console.log(`✅ Admin ${decoded.username} conectado`);

  // snapshot inicial
  sendDevicesSnapshot(ws);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.type === "request_remote_access") {
      const targetDeviceId = normDeviceId(data.deviceId);
      const deviceWs = wsAgentsByDeviceId.get(targetDeviceId);

      if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
        logs.push({
          adminId: decoded.id,
          deviceId: targetDeviceId,
          action: "request_remote_access",
          timestamp: new Date(),
        });

        safeSend(deviceWs, {
          type: "consent_request",
          admin: decoded.username,
        });
      } else {
        safeSend(ws, {
          type: "error",
          message: "Dispositivo offline",
        });
      }
      return;
    }

    if (data.type === "get_last_frame" && data.deviceId) {
      const id = normDeviceId(data.deviceId);
      const jpeg = lastFrameByDevice[id];
      if (jpeg) {
        safeSend(ws, {
          type: "screen_frame",
          deviceId: id,
          jpeg,
          ts: nowMs(),
        });
      }
      return;
    }
  });

  ws.on("close", (code) => {
    console.log(`🔌 Admin ${decoded.username} desconectado (code=${code})`);
  });

  ws.on("error", (err) => {
    console.log(`⚠️ WS admin error (${decoded.username}):`, err.message);
  });
}

wss.on("connection", (ws, req) => {
  const params = parseQuery(req.url);

  const role = params.get("role");             // "agent" | "admin"
  const deviceIdRaw = params.get("deviceId");  // ex: "device2"
  const token = params.get("token");           // padrão novo
  const adminToken = params.get("adminToken"); // compat antiga
  const effectiveAdminToken = adminToken || token;

  const deviceId = normDeviceId(deviceIdRaw);

  console.log("[WS] connection:", {
    role,
    deviceId: deviceId || null,
    hasToken: !!token,
    hasAdminToken: !!adminToken,
  });

  // ========== AGENT ==========
  if (role === "agent") {
    if (!deviceId) return ws.close(1008, "deviceId required");
    return handleAgent(ws, deviceId, params);
  }

  // ========== ADMIN ==========
  if (role === "admin") {
    if (!effectiveAdminToken) return ws.close(1008, "admin token required");
    return handleAdmin(ws, effectiveAdminToken);
  }

  // ========== FALLBACK COMPAT ==========
  if (deviceId) {
    console.log(`ℹ️ Conexão compat detectada. Tratando como agent: ${deviceId}`);
    return handleAgent(ws, deviceId, params);
  }

  if (effectiveAdminToken) {
    console.log(`ℹ️ Conexão compat detectada. Tratando como admin.`);
    return handleAdmin(ws, effectiveAdminToken);
  }

  ws.close(1008, "missing role");
});

// ============================
// Presence TTL job (anti-zumbi)
// ============================
setInterval(() => {
  const now = nowMs();

  for (const d of devices) {
    if (!d.connected) continue;

    const last = d.lastSeen || 0;
    if (now - last <= PRESENCE_TTL_MS) continue;

    const ws = wsAgentsByDeviceId.get(d.id);
    try {
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    } catch {}

    wsAgentsByDeviceId.delete(d.id);
    d.connected = false;

    console.log(`⏱️ PRESENCE TTL: marcando offline ${d.id}`);
    emitPresence(d.id, false, d);
  }
}, 5000);

// ============================
// Start
// ============================
server.listen(3001, "0.0.0.0", () => {
  console.log("Backend rodando na porta 3001");
});
