"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const JWT_SECRET = "supersecretkey";

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
  } catch { }
}

function loadJsonSafe(filePath, fallback) {
  ensureDataDir();
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
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

// { [deviceId]: { label, updatedAt } }
let deviceAliases = loadJsonSafe(ALIASES_PATH, {});

function getAliasLabel(deviceId) {
  const entry = deviceAliases[String(deviceId || "").trim()];
  const label = entry?.label ? String(entry.label).trim() : "";
  return label || "";
}

// ============================
// Persistência (compliance events)
// ============================
// ✅ Persistimos todos os eventos aqui (MVP produção LAN)
const COMPLIANCE_EVENTS_PATH = path.join(DATA_DIR, "compliance-events.json");

// [{ id, deviceId, alias, author, context, timestamp, content, matches, severity }]
let complianceEvents = loadJsonSafe(COMPLIANCE_EVENTS_PATH, []);
if (!Array.isArray(complianceEvents)) complianceEvents = [];

// ✅ Agregado por device (para alimentar ❗)
const complianceByDevice = new Map(); // deviceId -> { count, lastAt, lastSeverity }

function recomputeComplianceAgg() {
  complianceByDevice.clear();
  for (const ev of complianceEvents) {
    const deviceId = String(ev?.deviceId || "").trim();
    if (!deviceId) continue;

    const prev = complianceByDevice.get(deviceId) || {
      count: 0,
      lastAt: 0,
      lastSeverity: null,
    };

    const ts = Number(ev?.timestamp || 0);
    prev.count += 1;
    if (ts >= prev.lastAt) {
      prev.lastAt = ts;
      prev.lastSeverity = ev?.severity ?? prev.lastSeverity;
    }

    complianceByDevice.set(deviceId, prev);
  }
}
recomputeComplianceAgg();

function getComplianceState(deviceId) {
  const id = String(deviceId || "").trim();
  const agg = complianceByDevice.get(id);
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
// Compliance detector (MVP)
// ============================
// ✅ normalização para pegar variações (caps, símbolos, números, etc.)
function normalizeText(s) {
  const raw = String(s || "");
  const lower = raw.toLowerCase();

  // remove acentos
  const noAcc = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // troca leetspeak e símbolos comuns
  const leet = noAcc
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t");

  // remove pontuação/símbolos (mantém espaço)
  const cleaned = leet.replace(/[^a-z0-9\s]/g, " ");

  // colapsa espaços
  return cleaned.replace(/\s+/g, " ").trim();
}

// ✅ listas principais (você pode expandir depois sem mudar lógica)
const COMPLIANCE_TRIGGERS = [
  // 💰 por fora / pagamento direto
  "pode mandar o valor direto pra mim",
  "manda pra minha conta",
  "acerta por fora",
  "acerta isso por fora",
  "faz o pix nesse outro numero",
  "nao precisa passar pela empresa",
  "esse valor nao precisa ir na nota",
  "sem envolver o financeiro",
  "esse pagamento nao precisa aparecer",
  "isso nao entra no caixa da empresa",
  "comissao por fora",
  "parte pra mim",
  "fica uma parte pra mim",
  "a diferenca e minha",
  "esse dinheiro nao aparece",

  // 🧾 nota/sistema
  "nao lanca isso agora",
  "melhor nao colocar no sistema",
  "coloca outro valor na nota",
  "nao precisa gerar nf",
  "nao registra isso",
  "fora do sistema",
  "sem nota",

  // 🤝 conluio
  "fica so entre nos",
  "a empresa nao precisa saber",
  "nao comenta isso com ninguem",
  "isso e um acordo nosso",

  // 🤬 palavrões / ofensas (amostra MVP)
  "porra",
  "caralho",
  "merda",
  "bosta",
  "foda se",
  "vai tomar no cu",
  "vai se foder",
  "fdp",
  "filho da puta",
  "arrombado",
  "babaca",
  "idiota",
  "imbecil",
  "otario",
  "trouxa",
  "pqp",
  "vtnc",
];

function detectCompliance(content) {
  const norm = normalizeText(content);

  const matches = [];
  for (const t of COMPLIANCE_TRIGGERS) {
    const nt = normalizeText(t);
    if (!nt) continue;
    if (norm.includes(nt)) matches.push(t);
  }

  if (matches.length === 0) {
    return { suspicious: false, matches: [], severity: null };
  }

  // ✅ severidade MVP
  // high: por fora / dinheiro / comissão / dividir / pix
  // medium: sistema/nota
  // low: palavrão/ofensa
  const normJoined = matches.map((m) => normalizeText(m)).join(" | ");
  let severity = "low";

  if (
    normJoined.includes("por fora") ||
    normJoined.includes("pix") ||
    normJoined.includes("dinheiro") ||
    normJoined.includes("comissao") ||
    normJoined.includes("parte pra mim") ||
    normJoined.includes("a diferenca e minha")
  ) {
    severity = "high";
  } else if (
    normJoined.includes("nota") ||
    normJoined.includes("sistema") ||
    normJoined.includes("nf") ||
    normJoined.includes("nao registra") ||
    normJoined.includes("fora do sistema")
  ) {
    severity = "medium";
  }

  return { suspicious: true, matches, severity };
}

// ============================
// In-memory data (MVP)
// ============================
const adminsSeed = [
  { id: 1, username: "admin", passwordHash: bcrypt.hashSync("admin123", 10) },
];

// ✅ Devices começam vazios (sem seed de teste)
const devices = [];

// logs (MVP)
const logs = [];

// WS sessions
const wsAgentsByDeviceId = new Map(); // deviceId -> ws
const lastFrameByDevice = {}; // { [deviceId]: "data:image/jpeg;base64,..." }

// throttle por device
const lastFrameSentAtByDevice = {}; // { [deviceId]: number(ms) }
const MIN_FRAME_INTERVAL_MS = 120;

// Presence TTL (anti-zumbi)
const PRESENCE_TTL_MS = 15_000;
const HEARTBEAT_TYPE = "ping";

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
  const alias = getAliasLabel(d.id);
  const comp = getComplianceState(d.id);

  return {
    id: d.id,
    name: alias || d.name, // ✅ aplica alias no REST
    user: d.user, // pode manter "unknown" (UI ignora)
    connected: !!d.connected,
    online: !!d.connected,
    lastSeen: d.lastSeen,
    agentVersion: d.agentVersion,

    // ✅ compliance fields para ❗
    complianceFlag: comp.complianceFlag,
    complianceCount: comp.complianceCount,
    complianceLastAt: comp.complianceLastAt,
    complianceLastSeverity: comp.complianceLastSeverity,
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
  res.json(devices.map(toDeviceDTO));
});

app.get("/api/logs", authenticateAdmin, (req, res) => {
  res.json(logs);
});

// ✅ ALIASES
app.get("/api/device-aliases", authenticateAdmin, (req, res) => {
  res.json(deviceAliases);
});

app.put("/api/device-aliases/:deviceId", authenticateAdmin, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ error: "deviceId inválido" });

  const label = String(req.body?.label ?? "").trim();

  // label vazio => remove alias
  if (!label) {
    if (deviceAliases[deviceId]) {
      delete deviceAliases[deviceId];
      const okRemove = saveJsonSafe(ALIASES_PATH, deviceAliases);
      if (!okRemove) return res.status(500).json({ error: "Falha ao persistir alias" });
    }
    return res.json({ ok: true, deviceId, label: "" });
  }

  deviceAliases[deviceId] = {
    label,
    updatedAt: nowMs(),
  };

  const ok = saveJsonSafe(ALIASES_PATH, deviceAliases);
  if (!ok) return res.status(500).json({ error: "Falha ao persistir alias" });

  res.json({ ok: true, deviceId, label });
});

// ✅ COMPLIANCE: listar eventos (com filtro por deviceId)
app.get("/api/compliance/events", authenticateAdmin, (req, res) => {
  const deviceId = normDeviceId(req.query?.deviceId);
  const list = deviceId ? complianceEvents.filter((e) => e.deviceId === deviceId) : complianceEvents;
  res.json(list);
});

// ✅ COMPLIANCE: criar evento (manual/teste e integração futura do agent)
app.post("/api/compliance/events", authenticateAdmin, (req, res) => {
  const deviceId = normDeviceId(req.body?.deviceId);
  const context = String(req.body?.context ?? "").trim();
  const content = String(req.body?.content ?? "").trim();
  const author = String(req.admin?.username ?? "admin").trim();

  if (!deviceId) return res.status(400).json({ error: "deviceId obrigatório" });
  if (!content) return res.status(400).json({ error: "content obrigatório" });

  const { suspicious, matches, severity } = detectCompliance(content);

  // ✅ sempre registra (auditoria), mas marca suspeito quando bater
  const ev = {
    id: `cev_${nowMs()}_${crypto.randomBytes(8).toString("hex")}`,
    deviceId,
    alias: getAliasLabel(deviceId) || null,
    author,
    context: context || null,
    timestamp: nowMs(),
    content,
    matches,
    severity: suspicious ? severity : null,
    suspicious: !!suspicious,
  };

  complianceEvents.push(ev);
  const ok = saveJsonSafe(COMPLIANCE_EVENTS_PATH, complianceEvents);
  if (!ok) return res.status(500).json({ error: "Falha ao persistir compliance event" });

  if (suspicious) {
    // ✅ atualiza agregado do device
    const prev = complianceByDevice.get(deviceId) || { count: 0, lastAt: 0, lastSeverity: null };
    prev.count += 1;
    prev.lastAt = ev.timestamp;
    prev.lastSeverity = ev.severity;
    complianceByDevice.set(deviceId, prev);

    // ✅ avisa admins em realtime para subir o ❗ sem F5
    broadcastToAdmins({
      type: "compliance_event",
      deviceId,
      count: prev.count,
      severity: ev.severity,
      ts: ev.timestamp,
    });
  }

  return res.json({ ok: true, suspicious, event: ev });
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
    devices: devices.map((d) => {
      const alias = getAliasLabel(d.id);
      const comp = getComplianceState(d.id);

      return {
        deviceId: d.id,
        name: alias || d.name,
        online: !!d.connected,
        connected: !!d.connected,
        lastSeen: d.lastSeen,
        agentVersion: d.agentVersion,

        // ✅ compliance fields para UI
        complianceFlag: comp.complianceFlag,
        complianceCount: comp.complianceCount,
        complianceLastAt: comp.complianceLastAt,
        complianceLastSeverity: comp.complianceLastSeverity,
      };
    }),
    ts: nowMs(),
  });
}

function handleAgent(ws, deviceId, params) {
  let d = findDevice(deviceId);
  if (!d) {
    d = {
      id: deviceId,
      name: deviceId, // base
      user: "unknown",
      connected: false,
      lastSeen: null,
      agentVersion: null,
    };
    devices.push(d);
    console.log(`🆕 Registrando novo dispositivo automaticamente: ${deviceId}`);
  }

  const agentVersion = params.get("v") || null;

  d.connected = true;
  d.lastSeen = nowMs();
  if (agentVersion) d.agentVersion = agentVersion;

  wsAgentsByDeviceId.set(deviceId, ws);

  ws.isAgent = true;
  ws.deviceId = deviceId;

  console.log(`✅ Dispositivo ${deviceId} conectado (agent)`);
  emitPresence(deviceId, true, d);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data?.type === HEARTBEAT_TYPE) {
      const dev = findDevice(deviceId);
      if (dev) dev.lastSeen = nowMs();
      safeSend(ws, { type: "pong", ts: nowMs() });
      return;
    }

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

    if (data.type === "screen_frame") {
      if (data.deviceId && typeof data.jpeg === "string") {
        const fid = normDeviceId(data.deviceId);

        lastFrameByDevice[fid] = data.jpeg;

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

    // ✅ FUTURO (texto capturado): agent pode enviar {type:"text_captured", author, context, content}
    // MVP: se bater em compliance => cria evento e sobe ❗
    if (data.type === "text_captured" && typeof data.content === "string") {
      const content = String(data.content || "").trim();
      if (!content) return;

      const author = String(data.author || "unknown").trim();
      const context = String(data.context || "agent").trim();

      const { suspicious, matches, severity } = detectCompliance(content);

      const ev = {
        id: `cev_${nowMs()}_${crypto.randomBytes(8).toString("hex")}`,
        deviceId,
        alias: getAliasLabel(deviceId) || null,
        author,
        context,
        timestamp: nowMs(),
        content,
        matches,
        severity: suspicious ? severity : null,
        suspicious: !!suspicious,
      };

      complianceEvents.push(ev);
      const ok = saveJsonSafe(COMPLIANCE_EVENTS_PATH, complianceEvents);
      if (!ok) return;

      if (suspicious) {
        const prev = complianceByDevice.get(deviceId) || { count: 0, lastAt: 0, lastSeverity: null };
        prev.count += 1;
        prev.lastAt = ev.timestamp;
        prev.lastSeverity = ev.severity;
        complianceByDevice.set(deviceId, prev);

        broadcastToAdmins({
          type: "compliance_event",
          deviceId,
          count: prev.count,
          severity: ev.severity,
          ts: ev.timestamp,
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
        safeSend(ws, { type: "error", message: "Dispositivo offline" });
      }
      return;
    }

    if (data.type === "get_last_frame" && data.deviceId) {
      const id = normDeviceId(data.deviceId);
      const jpeg = lastFrameByDevice[id];
      if (jpeg) {
        safeSend(ws, { type: "screen_frame", deviceId: id, jpeg, ts: nowMs() });
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

  const role = params.get("role");
  const deviceIdRaw = params.get("deviceId");
  const token = params.get("token");
  const adminToken = params.get("adminToken");
  const effectiveAdminToken = adminToken || token;

  const deviceId = normDeviceId(deviceIdRaw);

  console.log("[WS] connection:", {
    role,
    deviceId: deviceId || null,
    hasToken: !!token,
    hasAdminToken: !!adminToken,
  });

  if (role === "agent") {
    if (!deviceId) return ws.close(1008, "deviceId required");
    return handleAgent(ws, deviceId, params);
  }

  if (role === "admin") {
    if (!effectiveAdminToken) return ws.close(1008, "admin token required");
    return handleAdmin(ws, effectiveAdminToken);
  }

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
    } catch { }

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
