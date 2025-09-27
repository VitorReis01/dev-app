const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');

let mainWindow;
let ws;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
}

// função pra garantir que o arquivo de config exista com valores padrões
function ensureAgentConfig() {
  const configDir = app.getPath('userData');
  const configPath = path.join(configDir, 'agent-config.json');

  // Se a pasta de userData não existir, garante que ela exista
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Se o arquivo não existir, cria com valores padrões
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      server: "192.168.1.100",  // coloca aqui o IP do PC admin que você sabe que está certo
      port: 3001,
      deviceId: "device2",      // pode mudar pro id que quiser
      token: "device-token"
    };
    try {
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      console.log('[desktop-agent] Criado agent-config.json padrão em', configPath);
    } catch (err) {
      console.error('[desktop-agent] Erro ao criar agent-config.json:', err);
    }
  }
}

function getServerBase() {
  // Garante que o arquivo exista antes de tentar ler
  ensureAgentConfig();

  // 1) variável de ambiente
  if (process.env.SERVER_URL) {
    console.log('Usando SERVER_URL da variável de ambiente:', process.env.SERVER_URL);
    return process.env.SERVER_URL;
  }

  // 2) arquivo agent-config.json em userData
  try {
    const configPath = path.join(app.getPath('userData'), 'agent-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.server && cfg.port) {
      const url = `ws://${cfg.server}:${cfg.port}`;
      console.log('Usando URL do agent-config.json:', url);
      return url;
    }
    if (cfg.url) {
      console.log('Usando URL direto do agent-config.json:', cfg.url);
      return cfg.url;
    }
  } catch (err) {
    console.error('❌ Erro ao ler agent-config.json:', err);
  }

  // fallback
  const fallbackUrl = 'ws://localhost:3001';
  console.log('Usando fallback URL:', fallbackUrl);
  return fallbackUrl;
}

function connectWS() {
  const deviceId = 'device2'; // ou o id que quiser
  const token = 'device-token';

  const base = getServerBase();
  const url = `${base}?deviceId=${deviceId}&token=${token}`;

  console.log('[desktop-agent] Conectando em:', url);

  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log("✅ Conectado ao servidor WebSocket");
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'consent_request') {
      mainWindow.webContents.send('consent-request', msg.admin);
    }

    if (msg.type === 'admin_connected') {
      mainWindow.webContents.send('admin-connected', msg.admin);
    }
  });

  ws.on('close', () => {
    console.log("🔌 Conexão perdida. Tentando reconectar em 5s...");
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (err) => {
    console.error("⚠️ Erro WS:", err.message);
  });
}

app.whenReady().then(() => {
  createWindow();
  connectWS();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on("consent-response", async (event, accepted) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "consent_response", accepted }));

    if (accepted) {
      mainWindow.webContents.send("start-screen-share");
    }
  }
});
