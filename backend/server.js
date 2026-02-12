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
// Mantém um histórico curto de logs em memória para diagnóstico no Admin Console
// e também espelha no console (útil no NSSM/serviço).
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

  try {
    console.log(
      `[${new Date(entry.ts).toISOString()}] ${entry.level}: ${entry.msg}`,
      entry.meta ?? ""
    );
  } catch { }
}

// ============================
// API GUARD: /api nunca pode cair no SPA fallback
// ============================
// Evita que requests para /api/* sejam respondidos com index.html do React.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ============================
// HTTP LOG (somente /api)
// ============================
// Loga chamadas REST para rastrear o que está sendo acessado.
app.use((req, _res, next) => {
  if (req.path && String(req.path).startsWith("/api/")) {
    addLog("INFO", `HTTP ${req.method} ${req.path}`, { ip: req.ip });
  }
  next();
});

// Mantém compatível com setup atual,
// mas permite trocar sem refatorar depois (via variável de ambiente).
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const PORT = Number(process.env.PORT || 3001);

// ============================
// MULTI-LOJA (TENANTS)
// ============================
// "Tenant" aqui significa a "loja/unidade" (ex: CLA1, CLA2, DLA1, DLA2).
// O isolamento é feito por tenant: admins só enxergam devices do(s) tenant(s)
// permitido(s) no token JWT.
const VALID_TENANTS = new Set(["CLA1", "CLA2", "DLA1", "DLA2"]);

// Compatibilidade com agents antigos: se o agent não enviar tenant,
// o servidor atribui este tenant padrão.
const DEFAULT_TENANT = String(process.env.LOOKOUT_DEFAULT_TENANT || "CLA1").trim().toUpperCase();

function normTenant(t) {
  const v = String(t || "").trim().toUpperCase();
  return v;
}

function isValidTenant(t) {
  const v = normTenant(t);
  return VALID_TENANTS.has(v);
}

function resolveTenantFromAgentQuery(params) {
  const q = normTenant(params.get("tenant"));
  if (q && isValidTenant(q)) return q;

  // Se veio vazio, assume DEFAULT_TENANT para não quebrar agentes atuais.
  // Se veio inválido (string qualquer), considera inválido e rejeita.
  if (!q) {
    if (!isValidTenant(DEFAULT_TENANT)) return null;
    return DEFAULT_TENANT;
  }
  return null;
}

function resolveTenantFromAdminJwt(decoded) {
  // decoded.allowedTenants pode ser ["*"] (master) ou lista de tenants.
  const raw = decoded?.allowedTenants;
  if (Array.isArray(raw) && raw.length) return raw;
  return [];
}

function isMasterAllowed(allowedTenants) {
  return Array.isArray(allowedTenants) && allowedTenants.includes("*");
}

function adminCanAccessTenant(allowedTenants, tenant) {
  if (isMasterAllowed(allowedTenants)) return true;
  const t = normTenant(tenant);
  return Array.isArray(allowedTenants) && allowedTenants.includes(t);
}

// ============================
// Persistência (data dir)
// ============================
const DATA_DIR = path.join(__dirname, "data");

// ============================
// Persistência (aliases)
// ============================
// Armazena apelidos/labels para deviceId.
// Mantém arquivo único (não separa por tenant ainda), mas filtra na leitura.
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
// Mantém eventos de compliance em arquivo único, e agrega por device em memória.
// Na leitura via API, filtra por tenant permitido (via deviceId -> tenant).
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
// Define usuários e quais tenants (lojas) cada um pode enxergar.
// allowedTenants:
//   - ["*"] => master (acesso total)
//   - ["CLA1","CLA2"] => acesso limitado às lojas listadas
const adminsSeed = [
  {
    id: 1,
    username: "lookout.master",
    passwordHash: bcrypt.hashSync("R7!Lookout$Master#CLA_DLA26", 10),
    allowedTenants: ["*"],
  },
  {
    id: 2,
    username: "adminCLA",
    passwordHash: bcrypt.hashSync("@ims1234!", 10),
    allowedTenants: ["CLA1", "CLA2"],
  },
  {
    id: 3,
    username: "adminDLA1",
    passwordHash: bcrypt.hashSync("@ims1234!", 10),
    allowedTenants: ["DLA1"],
  },
  {
    id: 4,
    username: "adminDLA2",
    passwordHash: bcrypt.hashSync("@ims1234!", 10),
    allowedTenants: ["DLA2"],
  },
];

// ============================
// In-memory
// ============================
// devices agora possuem tenant (loja) para permitir isolamento.
const devices = []; // { id, tenant, connected, lastSeen, agentVersion }
const wsAgentsByDeviceId = new Map();

//  pode guardar:
// - string base64 / dataURL (modo antigo)
// - OU Buffer (modo novo binário)
const lastFrameByDevice = Object.create(null);

// throttle p/ frames
const lastFrameSentAtByDevice = Object.create(null);
const MIN_FRAME_INTERVAL_MS = 250; // 4fps máximo

const PRESENCE_TTL_MS = 15000;

//  viewers MJPEG por device (para gating do stream)
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

function upsertDevice(id, tenantIfKnown) {
  const deviceId = normDeviceId(id);
  let d = findDevice(deviceId);
  if (!d) {
    d = {
      id: deviceId,
      tenant: tenantIfKnown && isValidTenant(tenantIfKnown) ? normTenant(tenantIfKnown) : DEFAULT_TENANT,
      connected: false,
      lastSeen: null,
      agentVersion: null,
    };
    devices.push(d);
  } else {
    // Atualiza tenant se vier informação explícita válida (ex: agent começou a enviar).
    if (tenantIfKnown && isValidTenant(tenantIfKnown)) {
      d.tenant = normTenant(tenantIfKnown);
    }
    // Se ainda não tem tenant válido, garante o padrão para consistência.
    if (!isValidTenant(d.tenant)) {
      d.tenant = isValidTenant(DEFAULT_TENANT) ? DEFAULT_TENANT : "CLA1";
    }
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

function getDeviceTenant(deviceId) {
  const d = findDevice(deviceId);
  return d?.tenant ? normTenant(d.tenant) : null;
}

function adminCanAccessDevice(allowedTenants, deviceId) {
  const t = getDeviceTenant(deviceId);
  if (!t) return false;
  return adminCanAccessTenant(allowedTenants, t);
}

function filterDevicesForAdmin(allowedTenants) {
  if (isMasterAllowed(allowedTenants)) return devices;
  return devices.filter((d) => adminCanAccessTenant(allowedTenants, d.tenant));
}

function filterAliasesForAdmin(allowedTenants) {
  if (isMasterAllowed(allowedTenants)) return deviceAliases;

  const out = {};
  for (const [deviceId, val] of Object.entries(deviceAliases || {})) {
    if (adminCanAccessDevice(allowedTenants, deviceId)) out[deviceId] = val;
  }
  return out;
}

function filterComplianceEventsForAdmin(allowedTenants, filterDeviceIdOptional) {
  const filterId = String(filterDeviceIdOptional || "").trim();

  const base = filterId
    ? complianceEvents.filter((e) => String(e?.deviceId || "").trim() === filterId)
    : complianceEvents;

  if (isMasterAllowed(allowedTenants)) return base;

  return base.filter((e) => adminCanAccessDevice(allowedTenants, String(e?.deviceId || "").trim()));
}

// ============================
// MJPEG viewers gating
// ============================
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

// compat: envia os 2 nomes (hífen e underscore)
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
// Broadcasts com isolamento por tenant
// ============================
// Envia eventos apenas para admins que têm permissão de ver o tenant do device.
function broadcastToAdminsFiltered(obj, tenant) {
  const t = normTenant(tenant);
  wss.clients.forEach((c) => {
    if (!c.isAdmin) return;
    if (c.readyState !== WebSocket.OPEN) return;

    const allowed = c.allowedTenants || [];
    if (!adminCanAccessTenant(allowed, t)) return;

    try {
      c.send(JSON.stringify(obj));
    } catch { }
  });
}

function broadcastPresence(deviceId, payload) {
  const t = getDeviceTenant(deviceId);
  if (!t) return;
  broadcastToAdminsFiltered(payload, t);
}

function sendSnapshotToAdmin(ws) {
  const allowed = ws.allowedTenants || [];
  const filtered = filterDevicesForAdmin(allowed).map((d) => ({ ...d }));
  safeSend(ws, { type: "devices_snapshot", devices: filtered });
}

// ============================
//  ADMIN CONSOLE (React build) (ANTES do fallback)
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
//  Health check (sem auth)
// ============================
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============================
// Auth
// ============================
// Login valida senha e emite JWT contendo allowedTenants do usuário.
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const admin = adminsSeed.find((a) => a.username === username);

  if (!admin || !bcrypt.compareSync(String(password || ""), admin.passwordHash)) {
    addLog("WARN", "Login inválido", { username: String(username || "") });
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign(
    {
      id: admin.id,
      username: admin.username,
      allowedTenants: Array.isArray(admin.allowedTenants) ? admin.allowedTenants : [],
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  addLog("INFO", "Login OK", { username: admin.username, allowedTenants: admin.allowedTenants });

  res.json({
    token,
    user: {
      id: admin.id,
      username: admin.username,
      allowedTenants: admin.allowedTenants,
    },
  });
});

function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Token necessário" });

  try {
    const decoded = jwt.verify(auth.replace("Bearer ", ""), JWT_SECRET);
    decoded.allowedTenants = resolveTenantFromAdminJwt(decoded);
    req.admin = decoded;
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
    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.allowedTenants = resolveTenantFromAdminJwt(decoded);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ============================
// REST
// ============================

// Lista devices filtrados por tenant permitido no JWT.
app.get("/api/devices", authenticateAdmin, (req, res) => {
  const allowedTenants = req.admin?.allowedTenants || [];
  const list = filterDevicesForAdmin(allowedTenants);

  const out = list.map((d) => {
    const comp = getComplianceState(d.id);
    const connected = !!d.connected;
    return {
      id: d.id,
      deviceId: d.id,
      name: d.id,
      tenant: d.tenant, // ajuda UI/diagnóstico
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

// Rota única do frame (1 imagem JPEG) com isolamento por tenant.
app.get("/api/devices/:deviceId/frame", authenticateAdminFlex, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);

  const allowedTenants = req.admin?.allowedTenants || [];
  if (!adminCanAccessDevice(allowedTenants, deviceId)) {
    addLog("WARN", "frame denied (tenant isolation)", { user: req.admin?.username, deviceId });
    return res.status(403).send("Forbidden");
  }

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

// MJPEG (stream estilo vídeo) + gating (enable/disable no agent) com isolamento por tenant.
app.get("/api/devices/:deviceId/mjpeg", authenticateAdminFlex, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);

  const allowedTenants = req.admin?.allowedTenants || [];
  if (!adminCanAccessDevice(allowedTenants, deviceId)) {
    addLog("WARN", "mjpeg denied (tenant isolation)", { user: req.admin?.username, deviceId });
    return res.status(403).send("Forbidden");
  }

  addLog("INFO", "MJPEG endpoint hit", {
    deviceId,
    hasToken: !!String(req.query?.token || ""),
    user: req.admin?.username || null,
  });

  const viewers = incMjpegViewer(deviceId);

  if (viewers === 1) {
    const agentWs = getAgentWs(deviceId);
    if (agentWs) {
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
    } catch { }

    const left = decMjpegViewer(deviceId);

    if (left === 0) {
      const agentWs = getAgentWs(deviceId);
      if (agentWs) {
        sendStreamDisable(agentWs, deviceId);
      }
    }
  });
});

// aliases (filtrados por tenant permitido)
app.get("/api/device-aliases", authenticateAdmin, (req, res) => {
  const allowedTenants = req.admin?.allowedTenants || [];
  res.json(filterAliasesForAdmin(allowedTenants));
});

app.put("/api/device-aliases/:deviceId", authenticateAdmin, (req, res) => {
  const id = normDeviceId(req.params.deviceId);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";

  if (!id) return res.status(400).json({ error: "deviceId inválido" });

  const allowedTenants = req.admin?.allowedTenants || [];
  if (!adminCanAccessDevice(allowedTenants, id)) {
    addLog("WARN", "alias update denied (tenant isolation)", { user: req.admin?.username, deviceId: id });
    return res.status(403).json({ error: "Forbidden" });
  }

  deviceAliases[id] = { label, updatedAt: new Date().toISOString() };
  saveJsonSafe(ALIASES_PATH, deviceAliases);

  res.json({ ok: true, deviceId: id, ...deviceAliases[id] });
});

// compliance events (filtrados por tenant permitido)
app.get("/api/compliance/events", authenticateAdmin, (req, res) => {
  const allowedTenants = req.admin?.allowedTenants || [];
  const filterId = String(req.query?.deviceId || "").trim();

  const out = filterComplianceEventsForAdmin(allowedTenants, filterId);

  res.json([...out].sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)));
});

// API 404 JSON
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    method: req.method,
    path: req.originalUrl,
  });
});

// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => {
  if (!fs.existsSync(ADMIN_INDEX_HTML)) {
    return res.status(404).send("Admin Console build not found");
  }
  res.sendFile(ADMIN_INDEX_HTML);
});

// ============================
// Presence TTL cleanup
// ============================
// Marca offline quando não recebe ping/frame há tempo suficiente.
// O broadcast respeita tenant (somente admins autorizados recebem).
setInterval(() => {
  const t = nowMs();
  for (const d of devices) {
    if (!d.connected) continue;
    const last = Number(d.lastSeen || 0);
    if (last && t - last > PRESENCE_TTL_MS) {
      d.connected = false;

      addLog("WARN", "Presence TTL: marcando device offline", { deviceId: d.id, tenant: d.tenant });

      broadcastPresence(d.id, {
        type: "device_presence",
        deviceId: d.id,
        online: false,
        lastSeen: t,
        agentVersion: d.agentVersion ?? null,
      });
    }
  }
}, 3000).unref?.();

// ============================
// WebSocket
// ============================
// Conexões:
// - Admin: ws://host/?role=admin&token=JWT
// - Agent: ws://host/?role=agent&deviceId=...&tenant=CLA1&v=...&token=agent
wss.on("connection", (ws, req) => {
  const url = String(req.url || "");

  // parse robusto do querystring
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

  // fecha conexão se role inválido
  if (role !== "admin" && role !== "agent") {
    addLog("WARN", "WS role inválido - fechando", { role, ip: req.socket?.remoteAddress });
    return ws.close(1008, "invalid role");
  }

  if (role === "admin") {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const allowedTenants = resolveTenantFromAdminJwt(decoded);

      ws.isAdmin = true;
      ws.adminUser = decoded.username;
      ws.allowedTenants = allowedTenants;

      addLog("INFO", "Admin conectado", { username: decoded.username, allowedTenants });

      // Envia snapshot filtrado do que este admin pode ver.
      sendSnapshotToAdmin(ws);
    } catch {
      addLog("ERROR", "Admin WS token inválido", { ip: req.socket?.remoteAddress });
      return ws.close(1008, "invalid admin token");
    }
  }

  // agent sem deviceId -> fecha
  if (role === "agent" && !deviceId) {
    addLog("WARN", "Agent conectou sem deviceId - fechando", { ip: req.socket?.remoteAddress });
    return ws.close(1008, "missing deviceId");
  }

  if (role === "agent" && deviceId) {
    // Tenant do agent vem da querystring; compat: se ausente, usa DEFAULT_TENANT.
    const tenant = resolveTenantFromAgentQuery(params);
    if (!tenant) {
      addLog("WARN", "Agent tenant inválido - fechando", { deviceId, tenantRaw: params.get("tenant") });
      return ws.close(1008, "invalid tenant");
    }

    const d = upsertDevice(deviceId, tenant);
    d.connected = true;
    d.lastSeen = nowMs();
    if (agentVersion) d.agentVersion = agentVersion;

    ws.isAgent = true;
    ws.deviceId = deviceId;
    ws.tenant = tenant;

    wsAgentsByDeviceId.set(deviceId, ws);

    addLog("INFO", "Agent conectado", { deviceId, tenant: d.tenant, agentVersion: d.agentVersion });

    broadcastPresence(deviceId, {
      type: "device_presence",
      deviceId,
      online: true,
      lastSeen: d.lastSeen,
      agentVersion: d.agentVersion,
    });
  }

  ws.on("message", (raw, isBinary) => {
    // ==========================
    // BINÁRIO (frames JPEG do agent)
    // ==========================
    if (ws.isAgent && isBinary) {
      const id = ws.deviceId;

      const d = upsertDevice(id, ws.tenant);
      d.lastSeen = nowMs();

      const lastAt = Number(lastFrameSentAtByDevice[id] || 0);
      const t = nowMs();
      if (t - lastAt < MIN_FRAME_INTERVAL_MS) return;
      lastFrameSentAtByDevice[id] = t;

      lastFrameByDevice[id] = Buffer.from(raw);

      addLog("INFO", "frame_received_binary", {
        deviceId: id,
        tenant: d.tenant,
        bytes: raw?.length || 0,
      });

      return;
    }

    // ==========================
    // JSON (mensagens de controle)
    // ==========================
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

    // Heartbeat
    if (msg?.type === "ping") {
      if (ws.isAgent && ws.deviceId) {
        const d = upsertDevice(ws.deviceId, ws.tenant);
        d.lastSeen = nowMs();
      }
      safeSend(ws, { type: "pong" });
      return;
    }

    // Admin pedindo suporte: só pode solicitar para device do tenant permitido.
    if (ws.isAdmin && msg?.type === "request_remote_access") {
      const targetId = normDeviceId(msg.deviceId);

      const allowedTenants = ws.allowedTenants || [];
      if (!adminCanAccessDevice(allowedTenants, targetId)) {
        addLog("WARN", "request_remote_access denied (tenant isolation)", {
          admin: ws.adminUser,
          deviceId: targetId,
        });

        safeSend(ws, {
          type: "consent_response",
          deviceId: targetId,
          accepted: false,
          reason: "forbidden",
        });
        return;
      }

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

    // Resposta de consentimento do agent: broadcast filtrado por tenant do device.
    if (ws.isAgent && msg?.type === "consent_response") {
      const id = ws.deviceId;
      const accepted = !!msg.accepted;

      const d = upsertDevice(id, ws.tenant);

      addLog("INFO", "consent_response", { deviceId: id, tenant: d.tenant, accepted });

      broadcastToAdminsFiltered({ type: "consent_response", deviceId: id, accepted }, d.tenant);
      return;
    }

    // Compat JSON-frame antigo
    if (ws.isAgent && (msg?.type === "frame" || msg?.type === "screen_frame")) {
      const id = ws.deviceId;

      const payload =
        typeof msg.jpegBase64 === "string"
          ? msg.jpegBase64
          : typeof msg.jpeg === "string"
            ? msg.jpeg
            : "";

      if (!payload) return;

      const d = upsertDevice(id, ws.tenant);
      d.lastSeen = nowMs();

      const lastAt = Number(lastFrameSentAtByDevice[id] || 0);
      const t = nowMs();
      if (t - lastAt < MIN_FRAME_INTERVAL_MS) return;
      lastFrameSentAtByDevice[id] = t;

      lastFrameByDevice[id] = payload;

      addLog("INFO", "frame_received_json", {
        deviceId: id,
        tenant: d.tenant,
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

      broadcastPresence(ws.deviceId, {
        type: "device_presence",
        deviceId: ws.deviceId,
        online: false,
        lastSeen: nowMs(),
        agentVersion: d?.agentVersion ?? null,
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
  addLog("INFO", "Backend rodando", {
    port: PORT,
    defaultTenant: DEFAULT_TENANT,
    validTenants: Array.from(VALID_TENANTS),
  });
});
