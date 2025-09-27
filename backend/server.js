const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'supersecretkey';

// Dados em memória (simulação)
const admins = [
  { id: 1, username: 'admin', passwordHash: bcrypt.hashSync('admin123', 10) }
];
const devices = [
  { id: 'device1', name: 'PC do João', user: 'João', connected: false }
];
const logs = [];
const wsClients = new Map(); // deviceId -> ws

// Login admin
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const admin = admins.find(a => a.username === username);
  if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token, user: { id: admin.id, username: admin.username } });
});

// Middleware para rotas protegidas
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token necessário' });
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Listar dispositivos
app.get('/api/devices', authenticateAdmin, (req, res) => {
  res.json(devices);
});

// Listar logs
app.get('/api/logs', authenticateAdmin, (req, res) => {
  res.json(logs);
});

// WebSocket (admin ↔ dispositivos)
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', ''));
  const deviceId = params.get('deviceId');
  const adminToken = params.get('adminToken');

  if (deviceId) {
    // Dispositivo conectando
    const device = devices.find(d => d.id === deviceId);
    if (!device) return ws.close();
    device.connected = true;
    wsClients.set(deviceId, ws);
    console.log(`Dispositivo ${deviceId} conectado`);

    ws.on('message', msg => {
      const data = JSON.parse(msg);
      if (data.type === 'consent_response') {
        logs.push({ deviceId, action: 'consent_response', accepted: data.accepted, timestamp: new Date() });
        // Notificar admins conectados
        wss.clients.forEach(client => {
          if (client.isAdmin && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'consent_response', deviceId, accepted: data.accepted }));
          }
        });
      }
    });

    ws.on('close', () => {
      device.connected = false;
      wsClients.delete(deviceId);
      console.log(`Dispositivo ${deviceId} desconectado`);
    });
  } else if (adminToken) {
    // Admin conectando
    try {
      const decoded = jwt.verify(adminToken, JWT_SECRET);
      ws.isAdmin = true;
      ws.adminId = decoded.id;
      console.log(`Admin ${decoded.username} conectado`);

      ws.on('message', msg => {
        const data = JSON.parse(msg);
        if (data.type === 'request_remote_access') {
          const deviceWs = wsClients.get(data.deviceId);
          if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
            logs.push({ adminId: decoded.id, deviceId: data.deviceId, action: 'request_remote_access', timestamp: new Date() });
            deviceWs.send(JSON.stringify({ type: 'consent_request', admin: decoded.username }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Dispositivo offline' }));
          }
        }
      });
    } catch {
      ws.close();
    }
  } else {
    ws.close();
  }
});

server.listen(3001, "0.0.0.0", () => console.log("Backend rodando na porta 3001"));
