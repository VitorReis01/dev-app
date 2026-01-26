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

// Dados em memória (simulação)
const admins = [
  { id: 1, username: "admin", passwordHash: bcrypt.hashSync("admin123", 10) }
];

const devices = [
  { id: "device1", name: "PC do João", user: "João", connected: false },
  { id: "device2", name: "Device 2", user: "User 2", connected: false }
];

const logs = [];
const wsClients = new Map(); // deviceId -> ws (AGENT)

// último frame por dispositivo (dataURL jpeg)
const lastFrameByDevice = {}; // { [deviceId]: "data:image/jpeg;base64,..." }

// ✅ throttle simples por device (pra não travar tudo)
const lastFrameSentAtByDevice = {}; // { [deviceId]: number(ms) }
const MIN_FRAME_INTERVAL_MS = 120; // ~8 fps no máximo (ajuste aqui)

// ============================
// Auth
// ============================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const admin = admins.find((a) => a.username === username);

  if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

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
  res.json(devices);
});

app.get("/api/logs", authenticateAdmin, (req, res) => {
  res.json(logs);
});

// endpoint HTTP pra buscar a tela (fallback / debug)
app.get("/api/devices/:id/frame", (req, res) => {
  const deviceId = req.params.id;
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
// WebSocket (admin ↔ dispositivos)
// ============================
wss.on("connection", (ws, req) => {
  const qs = (req.url || "").startsWith("/?")
    ? (req.url || "").slice(2)
    : (req.url || "").replace("/", "");
  const params = new URLSearchParams(qs);

  const role = params.get("role");             // "agent" | "admin"
  const deviceId = params.get("deviceId");     // ex: "device2"
  const token = params.get("token");           // padrão novo
  const adminToken = params.get("adminToken"); // compat antiga
  const effectiveAdminToken = adminToken || token;

  console.log("[WS] connection:", { role, deviceId, hasToken: !!token, hasAdminToken: !!adminToken });

  // ========== AGENT ==========
  if (role === "agent") {
    if (!deviceId) return ws.close(1008, "deviceId required");

    const device = devices.find((d) => d.id === deviceId);
    if (!device) return ws.close(1008, "unknown device");

    device.connected = true;
    wsClients.set(deviceId, ws);
    ws.isAgent = true;
    ws.deviceId = deviceId;

    console.log(`✅ Dispositivo ${deviceId} conectado (agent)`);

    ws.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      // ✅ CONSENT
      if (data.type === "consent_response") {
        logs.push({
          deviceId,
          action: "consent_response",
          accepted: !!data.accepted,
          timestamp: new Date()
        });

        // Notificar admins conectados
        wss.clients.forEach((client) => {
          if (client.isAdmin && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "consent_response",
              deviceId,
              accepted: !!data.accepted
            }));
          }
        });
      }

      // ✅ REALTIME: FRAME DA TELA -> salva e repassa pros ADMINS
      if (data.type === "screen_frame") {
        if (data.deviceId && typeof data.jpeg === "string") {
          // salva último frame (para endpoint HTTP)
          lastFrameByDevice[data.deviceId] = data.jpeg;

          // throttle por device (evita travar)
          const now = Date.now();
          const last = lastFrameSentAtByDevice[data.deviceId] || 0;
          if (now - last < MIN_FRAME_INTERVAL_MS) return;
          lastFrameSentAtByDevice[data.deviceId] = now;

          // manda AO VIVO pros admins via WS
          const payload = JSON.stringify({
            type: "screen_frame",
            deviceId: data.deviceId,
            jpeg: data.jpeg,
            ts: data.ts || now
          });

          wss.clients.forEach((client) => {
            if (client.isAdmin && client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        }
      }
    });

    ws.on("close", (code) => {
      const current = wsClients.get(deviceId);
      if (current === ws) {
        device.connected = false;
        wsClients.delete(deviceId);
      }
      console.log(`🔌 Dispositivo ${deviceId} desconectado (code=${code})`);
    });

    ws.on("error", (err) => {
      console.log(`⚠️ WS agent error (${deviceId}):`, err.message);
    });

    return;
  }

  // ========== ADMIN ==========
  if (role === "admin") {
    if (!effectiveAdminToken) return ws.close(1008, "admin token required");

    try {
      const decoded = jwt.verify(effectiveAdminToken, JWT_SECRET);

      ws.isAdmin = true;
      ws.adminId = decoded.id;
      ws.adminUser = decoded.username;

      console.log(`✅ Admin ${decoded.username} conectado`);

      ws.on("message", (msg) => {
        let data;
        try {
          data = JSON.parse(msg.toString());
        } catch {
          return;
        }

        if (data.type === "request_remote_access") {
          const targetDeviceId = data.deviceId;
          const deviceWs = wsClients.get(targetDeviceId);

          if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
            logs.push({
              adminId: decoded.id,
              deviceId: targetDeviceId,
              action: "request_remote_access",
              timestamp: new Date()
            });

            deviceWs.send(JSON.stringify({
              type: "consent_request",
              admin: decoded.username
            }));
          } else {
            ws.send(JSON.stringify({
              type: "error",
              message: "Dispositivo offline"
            }));
          }
        }

        // opcional: admin pedir o último frame imediatamente (caso precise)
        if (data.type === "get_last_frame" && data.deviceId) {
          const jpeg = lastFrameByDevice[data.deviceId];
          if (jpeg && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "screen_frame",
              deviceId: data.deviceId,
              jpeg,
              ts: Date.now()
            }));
          }
        }
      });

      ws.on("close", (code) => {
        console.log(`🔌 Admin ${decoded.username} desconectado (code=${code})`);
      });

      ws.on("error", (err) => {
        console.log(`⚠️ WS admin error (${decoded.username}):`, err.message);
      });

      return;
    } catch {
      return ws.close(1008, "invalid admin token");
    }
  }

  // ========== FALLBACK (compat) ==========
  if (deviceId) {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return ws.close(1008, "unknown device");

    device.connected = true;
    wsClients.set(deviceId, ws);
    ws.isAgent = true;
    ws.deviceId = deviceId;

    console.log(`✅ Dispositivo ${deviceId} conectado (agent compat)`);

    ws.on("close", () => {
      const current = wsClients.get(deviceId);
      if (current === ws) {
        device.connected = false;
        wsClients.delete(deviceId);
      }
      console.log(`🔌 Dispositivo ${deviceId} desconectado (compat)`);
    });

    return;
  }

  if (effectiveAdminToken) {
    try {
      const decoded = jwt.verify(effectiveAdminToken, JWT_SECRET);
      ws.isAdmin = true;
      ws.adminId = decoded.id;
      console.log(`✅ Admin ${decoded.username} conectado (compat)`);
      return;
    } catch {
      return ws.close(1008, "invalid admin token");
    }
  }

  ws.close(1008, "missing role");
});

server.listen(3001, "0.0.0.0", () => console.log("Backend rodando na porta 3001"));