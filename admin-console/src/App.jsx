import React, { useState, useEffect, useRef } from "react";

function ScreenViewer({ deviceId }) {
  const [tick, setTick] = useState(0);
  const viewerRef = useRef(null);

  useEffect(() => {
    if (!deviceId) return;

    const t = setInterval(() => setTick((x) => x + 1), 150); // ~7 fps
    return () => clearInterval(t);
  }, [deviceId]);

  const enterFullscreen = async () => {
    const el = viewerRef.current;
    if (!el) return;

    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); // Safari
      else if (el.msRequestFullscreen) el.msRequestFullscreen(); // legado
    } catch {
      alert("Não foi possível entrar em tela cheia.");
    }
  };

  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {}
  };

  if (!deviceId) return null;

  const frameUrl = `http://localhost:3001/api/devices/${deviceId}/frame?ts=${tick}`;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Tela do dispositivo: {deviceId}</h2>

        <button onClick={enterFullscreen}>Tela cheia</button>
        <button onClick={exitFullscreen}>Sair</button>

        <button onClick={() => window.open(frameUrl, "_blank")}>
          Abrir em nova guia
        </button>
      </div>

      <div
        ref={viewerRef}
        onDoubleClick={enterFullscreen}
        style={{
          width: "100%",
          maxWidth: 1100,
          border: "2px solid #333",
          borderRadius: 8,
          background: "#000",
          overflow: "hidden",
          cursor: "zoom-in",
        }}
        title="Duplo clique para tela cheia"
      >
        <img
          src={frameUrl}
          alt="screen"
          style={{
            width: "100%",
            display: "block",
          }}
        />
      </div>

      <div style={{ marginTop: 8, color: "#666" }}>
        Dica: duplo clique na tela para entrar em tela cheia. ESC para sair.
      </div>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [devices, setDevices] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  const ws = useRef(null);

  // Login
  const login = async (username, password) => {
    const res = await fetch("http://localhost:3001/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      const data = await res.json();
      setToken(data.token);
      setUser(data.user);
    } else {
      alert("Login falhou");
    }
  };

  // Buscar dispositivos e logs
  const fetchData = async () => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    const resDevices = await fetch("http://localhost:3001/api/devices", { headers });
    if (resDevices.ok) setDevices(await resDevices.json());

    const resLogs = await fetch("http://localhost:3001/api/logs", { headers });
    if (resLogs.ok) setLogs(await resLogs.json());
  };

  // WebSocket admin
  useEffect(() => {
    if (!token) return;

    ws.current = new WebSocket(`ws://localhost:3001/?role=admin&adminToken=${token}`);

    ws.current.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "consent_response") {
        alert(`Dispositivo ${msg.deviceId} ${msg.accepted ? "aceitou" : "recusou"} o suporte.`);
        fetchData();

        if (msg.accepted) {
          setSelectedDeviceId(msg.deviceId);
        }
      }
    };

    ws.current.onopen = () => {
      fetchData();
    };

    ws.current.onerror = () => {};

    return () => {
      try {
        ws.current?.close();
      } catch {}
    };
  }, [token]);

  const requestSupport = (deviceId) => {
    setSelectedDeviceId(deviceId);

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: "request_remote_access", deviceId }));
    } else {
      alert("WebSocket não conectado ainda. Tente novamente em 1-2s.");
    }
  };

  if (!token) return <LoginForm onLogin={login} />;

  return (
    <div>
      <h1>MDM Console - Bem-vindo {user.username}</h1>

      <h2>Dispositivos</h2>
      <ul>
        {devices.map((d) => (
          <li key={d.id}>
            {d.name} ({d.user}) - {d.connected ? "Online" : "Offline"}{" "}
            <button onClick={() => requestSupport(d.id)} disabled={!d.connected}>
              Suporte
            </button>

            {d.connected && (
              <button style={{ marginLeft: 8 }} onClick={() => setSelectedDeviceId(d.id)}>
                Ver tela
              </button>
            )}
          </li>
        ))}
      </ul>

      <ScreenViewer deviceId={selectedDeviceId} />

      <h2>Logs</h2>
      <ul>
        {logs.map((log, i) => (
          <li key={i}>
            {String(log.timestamp)} - {log.action}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LoginForm({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(username, password);
      }}
    >
      <h2>Login Admin</h2>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuário" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Senha" />
      <button type="submit">Entrar</button>
    </form>
  );
}

export default App;