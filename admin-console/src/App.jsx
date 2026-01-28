import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ============================================
 * CONFIG (HTTP + WS)
 * ============================================
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
function normId(id) {
  return String(id || "").trim();
}

function isOnline(device) {
  return !!(device?.connected ?? device?.online);
}

function arrayToMapById(list) {
  const out = {};
  for (const d of list || []) {
    const id = normId(d.id ?? d.deviceId);
    if (!id) continue;

    out[id] = {
      id,
      name: d.name ?? out[id]?.name ?? "",
      connected: !!(d.connected ?? d.online),
      online: !!(d.online ?? d.connected),
      lastSeen: d.lastSeen ?? null,
      agentVersion: d.agentVersion ?? null,

      // ✅ compliance (para ❗)
      complianceFlag: !!d.complianceFlag,
      complianceCount: Number(d.complianceCount || 0),
      complianceLastAt: d.complianceLastAt ?? null,
      complianceLastSeverity: d.complianceLastSeverity ?? null,
    };
  }
  return out;
}

function applyPresencePatch(prevById, patch) {
  const deviceId = normId(patch?.deviceId);
  if (!deviceId) return prevById;

  const prev = prevById[deviceId] || { id: deviceId, name: deviceId };
  const connected = !!patch.online;

  return {
    ...prevById,
    [deviceId]: {
      ...prev,
      connected,
      online: connected,
      lastSeen: patch.lastSeen ?? prev.lastSeen ?? null,
      agentVersion: patch.agentVersion ?? prev.agentVersion ?? null,
      // ✅ presence não mexe em compliance
    },
  };
}

/**
 * ============================================
 * ScreenViewer
 * ============================================
 */
function ScreenViewer({ deviceId, displayName }) {
  const [tick, setTick] = useState(0);
  const viewerRef = useRef(null);

  useEffect(() => {
    if (!deviceId) return;
    const t = setInterval(() => setTick((x) => x + 1), 150);
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
        <h2 style={{ margin: 0 }}>
          Tela do dispositivo: {displayName ? displayName : deviceId}{" "}
          <span style={{ color: "#777", fontSize: 12 }}>({deviceId})</span>
        </h2>

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
 */
function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);

  const [devicesById, setDevicesById] = useState({});
  const [logs, setLogs] = useState([]);

  // ✅ Aliases persistidos no backend
  const [aliasesById, setAliasesById] = useState({});

  // UI rename
  const [editingDeviceId, setEditingDeviceId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  // ✅ Compliance UI (painel)
  const [showCompliance, setShowCompliance] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState([]);
  const [complianceFilterDeviceId, setComplianceFilterDeviceId] = useState("");

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  const devices = useMemo(() => {
    return Object.values(devicesById).sort((a, b) => a.id.localeCompare(b.id));
  }, [devicesById]);

  const getAliasLabel = (deviceId) => {
    const id = normId(deviceId);
    const entry = aliasesById[id];
    const label = entry?.label ? String(entry.label).trim() : "";
    return label || "";
  };

  const getDisplayName = (device) => {
    const id = normId(device?.id);
    const alias = getAliasLabel(id);
    if (alias) return alias;
    return device?.name || id;
  };

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
   * REST SNAPSHOT
   * ============================================
   */
  const fetchDevices = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/devices`, { headers });
    if (!res.ok) return;

    const list = await res.json();

    // ✅ IMPORTANTE: replace total (remove ghosts)
    setDevicesById(arrayToMapById(list));
  };

  const fetchLogs = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/logs`, { headers });
    if (!res.ok) return;
    setLogs(await res.json());
  };

  const fetchAliases = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/device-aliases`, { headers });
    if (!res.ok) return;

    const data = await res.json();
    const normalized = {};
    for (const [k, v] of Object.entries(data || {})) {
      const id = normId(k);
      if (!id) continue;

      if (typeof v === "string") {
        normalized[id] = { label: v, updatedAt: null };
      } else {
        normalized[id] = {
          label: typeof v?.label === "string" ? v.label : "",
          updatedAt: v?.updatedAt ?? null,
        };
      }
    }
    setAliasesById(normalized);
  };

  // ✅ Compliance events
  const fetchComplianceEvents = async (authToken, deviceIdFilter) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const q = deviceIdFilter ? `?deviceId=${encodeURIComponent(deviceIdFilter)}` : "";
    const res = await fetch(`${HTTP_BASE}/api/compliance/events${q}`, { headers });
    if (!res.ok) return;
    setComplianceEvents(await res.json());
  };

  const fetchData = async (authToken) => {
    if (!authToken) return;
    await Promise.all([fetchDevices(authToken), fetchLogs(authToken), fetchAliases(authToken)]);
  };

  /**
   * ============================================
   * WS ADMIN (realtime)
   * ============================================
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
      const attempt = reconnectAttemptsRef.current;
      const delay = Math.min(5000, 600 + attempt * 400);

      reconnectTimerRef.current = setTimeout(() => {
        connectWs();
      }, delay);
    };

    const connectWs = () => {
      cleanupWs();

      const ws = new WebSocket(`${WS_BASE}/?role=admin&token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = async () => {
        reconnectAttemptsRef.current = 0;
        await fetchData(token);
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "devices_snapshot" && Array.isArray(msg.devices)) {
          // ✅ IMPORTANTE: replace total (remove ghosts)
          setDevicesById(arrayToMapById(msg.devices));
          return;
        }

        if (msg.type === "device_presence") {
          setDevicesById((prev) => applyPresencePatch(prev, msg));
          return;
        }

        if (msg.type === "consent_response") {
          alert(`Dispositivo ${msg.deviceId} ${msg.accepted ? "aceitou" : "recusou"} o suporte.`);
          fetchLogs(token);

          if (msg.accepted) {
            setSelectedDeviceId(normId(msg.deviceId));
          }
          return;
        }

        // ✅ Realtime: evento SUSPEITO => liga o ❗ já
        if (msg.type === "compliance_event" && msg.deviceId) {
          const id = normId(msg.deviceId);
          setDevicesById((prev) => {
            const p = prev[id] || { id, name: id };
            const nextCount = Math.max(Number(p.complianceCount || 0), Number(msg.count || 0));

            return {
              ...prev,
              [id]: {
                ...p,
                complianceFlag: true,
                complianceCount: nextCount,
                complianceLastAt: msg.ts ?? p.complianceLastAt ?? null,
                complianceLastSeverity: msg.severity ?? p.complianceLastSeverity ?? null,
              },
            };
          });

          if (showCompliance) {
            fetchComplianceEvents(token, complianceFilterDeviceId || "");
          }
          return;
        }
      };

      ws.onclose = () => scheduleReconnect();
    };

    connectWs();

    return () => {
      closedByCleanup = true;
      cleanupWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, showCompliance, complianceFilterDeviceId]);

  /**
   * ============================================
   * AÇÃO: pedir suporte
   * ============================================
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
   * AÇÃO: renomear
   * ============================================
   */
  const startRename = (deviceId) => {
    const id = normId(deviceId);
    setEditingDeviceId(id);
    setEditingValue(getAliasLabel(id) || "");
  };

  const cancelRename = () => {
    setEditingDeviceId(null);
    setEditingValue("");
  };

  const saveRename = async (deviceId) => {
    const id = normId(deviceId);
    const label = String(editingValue || "").trim();

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${HTTP_BASE}/api/device-aliases/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ label }),
    });

    if (!res.ok) {
      alert("Falha ao salvar nome do dispositivo.");
      return;
    }

    setAliasesById((prev) => ({
      ...prev,
      [id]: { label, updatedAt: new Date().toISOString() },
    }));

    cancelRename();
  };

  /**
   * ============================================
   * UI: Login
   * ============================================
   */
  if (!token) return <LoginForm onLogin={login} />;

  const selectedDisplayName = selectedDeviceId
    ? getDisplayName(devicesById[selectedDeviceId] || { id: selectedDeviceId, name: selectedDeviceId })
    : "";

  const openCompliancePanel = async (deviceId) => {
    setShowCompliance(true);
    const id = normId(deviceId);
    setComplianceFilterDeviceId(id);
    await fetchComplianceEvents(token, id);
  };

  const refreshCompliance = async () => {
    await fetchComplianceEvents(token, complianceFilterDeviceId || "");
  };

  return (
    <div style={{ padding: 16 }}>
      <h1>MDM Console - Bem-vindo {user?.username}</h1>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Dispositivos</h2>

          <button
            onClick={async () => {
              const next = !showCompliance;
              setShowCompliance(next);
              if (next) {
                setComplianceFilterDeviceId("");
                await fetchComplianceEvents(token, "");
              }
            }}
          >
            {showCompliance ? "Fechar Compliance" : "Compliance"}
          </button>
        </div>

        <ul style={{ paddingLeft: 18 }}>
          {devices.map((d) => {
            const online = isOnline(d);
            const displayName = getDisplayName(d);
            const deviceId = d.id;

            const isEditing = editingDeviceId === deviceId;

            const flag = !!d.complianceFlag;
            const count = Number(d.complianceCount || 0);

            return (
              <li key={d.id} style={{ marginBottom: 10 }}>
                {!isEditing ? (
                  <>
                    {flag && (
                      <span
                        title={`Compliance: ${count} evento(s) suspeito(s). Clique para ver.`}
                        style={{ marginRight: 6, cursor: "pointer" }}
                        onClick={() => openCompliancePanel(deviceId)}
                      >
                        ❗{count > 0 ? `(${count})` : ""}
                      </span>
                    )}

                    <strong>{displayName}</strong>{" "}
                    <span style={{ color: "#777", fontSize: 12 }}>({deviceId})</span>{" "}
                    -{" "}
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
                    <button style={{ marginLeft: 8 }} onClick={() => startRename(d.id)}>
                      Renomear
                    </button>

                    <span style={{ marginLeft: 10, color: "#666", fontSize: 12 }}>
                      {d.agentVersion ? `v${d.agentVersion}` : ""}{" "}
                      {d.lastSeen ? `| lastSeen: ${new Date(d.lastSeen).toLocaleTimeString()}` : ""}{" "}
                      {flag && d.complianceLastSeverity ? `| compliance: ${d.complianceLastSeverity}` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <input
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      placeholder="Ex: Lucineia Cruz - Vendas"
                      style={{ width: 320 }}
                      autoFocus
                    />
                    <button style={{ marginLeft: 8 }} onClick={() => saveRename(d.id)}>
                      Salvar
                    </button>
                    <button style={{ marginLeft: 8 }} onClick={cancelRename}>
                      Cancelar
                    </button>

                    <span style={{ marginLeft: 10, color: "#666", fontSize: 12 }}>
                      Dica: deixe vazio e salve para remover o nome amigável.
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {showCompliance && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #ccc", borderRadius: 8, maxWidth: 1100 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Compliance</h2>

            <input
              value={complianceFilterDeviceId}
              onChange={(e) => setComplianceFilterDeviceId(e.target.value)}
              placeholder="Filtrar por deviceId (opcional)"
              style={{ width: 260 }}
            />
            <button
              onClick={async () => {
                await fetchComplianceEvents(token, complianceFilterDeviceId || "");
              }}
            >
              Filtrar
            </button>
            <button onClick={refreshCompliance}>Atualizar</button>

            <span style={{ marginLeft: 10, color: "#666", fontSize: 12 }}>
              Fonte: {HTTP_BASE}/api/compliance/events
            </span>
          </div>

          <div style={{ color: "#666", fontSize: 12, marginBottom: 10 }}>
            Clique no ❗ ao lado de um dispositivo para abrir já filtrado.
          </div>

          <ul style={{ paddingLeft: 18 }}>
            {complianceEvents.map((ev) => {
              const id = ev?.id || `${ev?.timestamp || ""}`;
              const ts = ev?.timestamp ? new Date(ev.timestamp).toLocaleString() : "";
              const dev = ev?.deviceId || "";
              const alias = ev?.alias ? ` - ${ev.alias}` : "";
              const sev = ev?.severity ? String(ev.severity) : "";
              const author = ev?.author ? String(ev.author) : "";
              const content = ev?.content ? String(ev.content) : "";
              const matches = Array.isArray(ev?.matches) ? ev.matches.join(", ") : "";

              return (
                <li key={id} style={{ marginBottom: 8 }}>
                  <strong>❗ {sev}</strong> — {ts} — <span style={{ color: "#333" }}>{dev}{alias}</span>{" "}
                  <span style={{ color: "#777" }}>| autor: {author}</span>
                  <div style={{ marginTop: 4, color: "#333" }}>{content}</div>
                  {matches && <div style={{ marginTop: 2, color: "#777", fontSize: 12 }}>match: {matches}</div>}
                </li>
              );
            })}
            {complianceEvents.length === 0 && <li>Nenhum evento encontrado.</li>}
          </ul>
        </div>
      )}

      <ScreenViewer deviceId={selectedDeviceId} displayName={selectedDisplayName} />

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
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuário" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha"
        />

        <button type="submit">Entrar</button>

        <div style={{ marginTop: 8, color: "#666", fontSize: 12 }}>Backend: {HTTP_BASE}</div>
      </div>
    </form>
  );
}

export default App;
