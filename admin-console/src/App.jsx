import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ============================================
 * CONFIG (HTTP + WS)
 * ============================================
 * - Mantém seu modelo atual (HOST/PORT separados)
 * - Permite rodar admin-console em outro PC da rede
 * - Fallbacks seguros para ambiente dev
 */
const BACKEND_HOST = process.env.REACT_APP_BACKEND_HOST || "localhost";
const BACKEND_PORT = process.env.REACT_APP_BACKEND_PORT || "3001";

const HTTP_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const WS_BASE = `ws://${BACKEND_HOST}:${BACKEND_PORT}`;

/**
 * ============================================
 * UTILIDADES
 * ============================================
 */

/** Normaliza deviceId para evitar mismatch por espaços/case */
function normId(id) {
  return String(id || "").trim();
}

/** Decide "online" de forma compatível (backend pode mandar connected e/ou online) */
function isOnline(device) {
  return !!(device?.connected ?? device?.online);
}

/** Converte array em map por id (state normalizado) */
function arrayToMapById(list) {
  const out = {};
  for (const d of list || []) {
    const id = normId(d.id ?? d.deviceId);
    if (!id) continue;

    out[id] = {
      // Campos canônicos no front
      id,
      name: d.name ?? out[id]?.name ?? "",
      user: d.user ?? out[id]?.user ?? "",
      connected: !!(d.connected ?? d.online),
      online: !!(d.online ?? d.connected), // compat
      lastSeen: d.lastSeen ?? null,
      agentVersion: d.agentVersion ?? null,
    };
  }
  return out;
}

/**
 * Aplica patch de presença (device_presence) no map normalizado.
 * - Se o device ainda não existe no map, cria uma entrada mínima (não quebra UI).
 * - Mantém name/user se já existirem.
 */
function applyPresencePatch(prevById, patch) {
  const deviceId = normId(patch?.deviceId);
  if (!deviceId) return prevById;

  const prev = prevById[deviceId] || { id: deviceId, name: deviceId, user: "" };

  const connected = !!patch.online;

  return {
    ...prevById,
    [deviceId]: {
      ...prev,
      connected,
      online: connected,
      lastSeen: patch.lastSeen ?? prev.lastSeen ?? null,
      agentVersion: patch.agentVersion ?? prev.agentVersion ?? null,
    },
  };
}

/**
 * ============================================
 * ScreenViewer
 * ============================================
 * - Mantém seu polling HTTP /frame (~7fps)
 * - Fullscreen com duplo clique
 * - Debug: abrir frame em nova aba
 */
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
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (el.msRequestFullscreen) el.msRequestFullscreen();
    } catch {
      alert("Não foi possível entrar em tela cheia.");
    }
  };

  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch { }
  };

  if (!deviceId) return null;

  const frameUrl = `${HTTP_BASE}/api/devices/${deviceId}/frame?ts=${tick}`;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Tela do dispositivo: {deviceId}</h2>

        <button onClick={enterFullscreen}>Tela cheia</button>
        <button onClick={exitFullscreen}>Sair</button>

        <button onClick={() => window.open(frameUrl, "_blank")}>Abrir em nova guia</button>
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

/**
 * ============================================
 * App
 * ============================================
 * Estratégia nível produção (MVP):
 * - REST (GET /devices, GET /logs) para snapshot "full"
 * - WebSocket para eventos incrementais:
 *     - devices_snapshot (estado inicial de presença sem polling)
 *     - device_presence (online/offline em tempo real)
 *     - consent_response (seu fluxo atual)
 */
function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);

  // State normalizado (permite patch incremental sem re-fetch)
  const [devicesById, setDevicesById] = useState({});
  const [logs, setLogs] = useState([]);

  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  // WS ref (não força re-render)
  const wsRef = useRef(null);

  // Reconexão leve (evita loop insano em caso de backend offline)
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  /**
   * devices (array) derivado do map normalizado.
   * - useMemo evita recalcular a cada render.
   */
  const devices = useMemo(() => {
    return Object.values(devicesById).sort((a, b) => a.id.localeCompare(b.id));
  }, [devicesById]);

  /**
   * ============================================
   * LOGIN
   * ============================================
   */
  const login = async (username, password) => {
    const res = await fetch(`${HTTP_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      alert("Login falhou");
      return;
    }

    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
  };

  /**
   * ============================================
   * REST SNAPSHOT (devices + logs)
   * ============================================
   * - Útil para carregar name/user e garantir consistência
   * - Presença real-time vem pelo WS
   */
  const fetchDevices = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/devices`, { headers });
    if (!res.ok) return;

    const list = await res.json();
    setDevicesById((prev) => {
      // preserva patches que chegaram via WS e mescla com o snapshot
      const next = { ...prev, ...arrayToMapById(list) };
      return next;
    });
  };

  const fetchLogs = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/logs`, { headers });
    if (!res.ok) return;
    setLogs(await res.json());
  };

  const fetchData = async (authToken) => {
    if (!authToken) return;
    await Promise.all([fetchDevices(authToken), fetchLogs(authToken)]);
  };

  /**
   * ============================================
   * WS ADMIN (realtime)
   * ============================================
   * - Conecta com token JWT
   * - Recebe:
   *    - devices_snapshot: presença inicial imediata
   *    - device_presence: delta por device
   *    - consent_response: fluxo atual
   *
   * NOTA: seu backend aceita token em "token" e também "adminToken".
   */
  useEffect(() => {
    if (!token) return;

    let closedByCleanup = false;

    const cleanupWs = () => {
      try {
        wsRef.current?.close();
      } catch { }
      wsRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (closedByCleanup) return;

      reconnectAttemptsRef.current += 1;

      // backoff simples: 0.8s, 1.2s, 2s, 3s, 5s...
      const attempt = reconnectAttemptsRef.current;
      const delay = Math.min(5000, 600 + attempt * 400);

      reconnectTimerRef.current = setTimeout(() => {
        connectWs();
      }, delay);
    };

    const connectWs = () => {
      cleanupWs();

      // ws admin com token JWT
      const ws = new WebSocket(`${WS_BASE}/?role=admin&token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = async () => {
        reconnectAttemptsRef.current = 0;

        // Carrega snapshot "full" via REST (name/user etc.)
        // (presença em tempo real vem do WS)
        await fetchData(token);
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        // 1) Snapshot inicial de presença
        if (msg.type === "devices_snapshot" && Array.isArray(msg.devices)) {
          // msg.devices: [{ deviceId, online, lastSeen, agentVersion, ... }]
          setDevicesById((prev) => {
            const next = { ...prev };

            for (const item of msg.devices) {
              const id = normId(item.deviceId ?? item.id);
              if (!id) continue;

              const prevDev = next[id] || { id, name: id, user: "" };
              const connected = !!(item.connected ?? item.online);

              next[id] = {
                ...prevDev,
                connected,
                online: connected,
                lastSeen: item.lastSeen ?? prevDev.lastSeen ?? null,
                agentVersion: item.agentVersion ?? prevDev.agentVersion ?? null,
              };
            }

            return next;
          });

          return;
        }

        // 2) Delta de presença em tempo real
        if (msg.type === "device_presence") {
          setDevicesById((prev) => applyPresencePatch(prev, msg));
          return;
        }

        // 3) Seu fluxo atual de consentimento
        if (msg.type === "consent_response") {
          alert(`Dispositivo ${msg.deviceId} ${msg.accepted ? "aceitou" : "recusou"} o suporte.`);
          // Logs podem ter mudado
          fetchLogs(token);

          if (msg.accepted) {
            setSelectedDeviceId(normId(msg.deviceId));
          }
          return;
        }

        // Opcional (se você quiser consumir frames via WS no futuro):
        // if (msg.type === "screen_frame") { ... }
      };

      ws.onerror = () => {
        // erro geralmente precede close
      };

      ws.onclose = () => {
        scheduleReconnect();
      };
    };

    connectWs();

    return () => {
      closedByCleanup = true;
      cleanupWs();
    };
  }, [token]);

  /**
   * ============================================
   * AÇÃO: pedir suporte
   * ============================================
   * - Envia request_remote_access ao backend
   * - Backend encaminha consent_request ao agent
   */
  const requestSupport = (deviceId) => {
    const id = normId(deviceId);
    setSelectedDeviceId(id);

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "request_remote_access", deviceId: id }));
    } else {
      alert("WebSocket não conectado ainda. Tente novamente em 1-2s.");
    }
  };

  /**
   * ============================================
   * UI: Login
   * ============================================
   */
  if (!token) return <LoginForm onLogin={login} />;

  return (
    <div style={{ padding: 16 }}>
      <h1>MDM Console - Bem-vindo {user?.username}</h1>

      <div style={{ marginTop: 16 }}>
        <h2>Dispositivos</h2>

        <ul style={{ paddingLeft: 18 }}>
          {devices.map((d) => {
            const online = isOnline(d);

            return (
              <li key={d.id} style={{ marginBottom: 10 }}>
                <strong>{d.name}</strong> ({d.user}) -{" "}
                <span style={{ color: online ? "green" : "gray" }}>
                  {online ? "Online" : "Offline"}
                </span>{" "}
                <button onClick={() => requestSupport(d.id)} disabled={!online}>
                  Suporte
                </button>

                {online && (
                  <button style={{ marginLeft: 8 }} onClick={() => setSelectedDeviceId(d.id)}>
                    Ver tela
                  </button>
                )}

                {/* Debug útil em dev/produção */}
                <span style={{ marginLeft: 10, color: "#666", fontSize: 12 }}>
                  {d.agentVersion ? `v${d.agentVersion}` : ""}{" "}
                  {d.lastSeen ? `| lastSeen: ${new Date(d.lastSeen).toLocaleTimeString()}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <ScreenViewer deviceId={selectedDeviceId} />

      <div style={{ marginTop: 24 }}>
        <h2>Logs</h2>
        <ul style={{ paddingLeft: 18 }}>
          {logs.map((log, i) => (
            <li key={i}>
              {String(log.timestamp)} - {log.action}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * ============================================
 * LoginForm
 * ============================================
 * - simples e direto
 * - evita re-render desnecessário
 */
function LoginForm({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(username, password);
      }}
      style={{ padding: 16 }}
    >
      <h2>Login Admin</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Usuário"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha"
        />

        <button type="submit">Entrar</button>

        <div style={{ marginTop: 8, color: "#666", fontSize: 12 }}>
          Backend: {HTTP_BASE}
        </div>
      </div>
    </form>
  );
}

export default App;
