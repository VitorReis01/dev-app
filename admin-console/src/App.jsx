import React, { useEffect, useMemo, useRef, useState } from "react";
import BackgroundEye from "./components/BackgroundEye";
import "./app-shell.css";

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
function ScreenViewer({ deviceId, displayName, onClose }) {
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

  const closeViewer = async () => {
    await exitFullscreen();
    if (typeof onClose === "function") onClose();
  };

  if (!deviceId) return null;

  const frameUrl = `${HTTP_BASE}/api/devices/${deviceId}/frame?ts=${tick}`;

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head">
        <div>
          <div className="panel-title">
            Tela do dispositivo: {displayName ? displayName : deviceId}{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              ({deviceId})
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Dica: duplo clique para tela cheia. ESC para sair do fullscreen.
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={enterFullscreen}>
            Tela cheia
          </button>

          <button className="btn" onClick={exitFullscreen} title="Sai do fullscreen, mas mantém o viewer aberto">
            Sair tela cheia
          </button>

          <button className="btn" onClick={closeViewer} title="Fecha o viewer e limpa a seleção">
            Fechar
          </button>

          <button className="btn red" onClick={() => window.open(frameUrl, "_blank")}>
            Abrir em nova guia
          </button>
        </div>
      </div>

      <div
        ref={viewerRef}
        onDoubleClick={enterFullscreen}
        className="viewer"
        title="Duplo clique para tela cheia"
      >
        <img src={frameUrl} alt="screen" className="viewer-img" />
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
    <>
      <BackgroundEye />
      <div className="app-layer">
        <div className="login-wrap">
          <div className="login-card">
            <div className="login-brand">
              <span className="logo-dot">👁️</span>
              <span>LOOKOUT</span>
            </div>
            <div className="login-sub">Admin Console</div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onLogin(username, password);
              }}
            >
              <div className="field">
                <label>Usuário</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
              </div>

              <div className="field">
                <label>Senha</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>

              <button className="btn red full" type="submit">
                Entrar
              </button>

              <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                Backend: {HTTP_BASE}
              </div>
            </form>
          </div>
        </div>
      </div>
    </>
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

  const [aliasesById, setAliasesById] = useState({});

  const [editingDeviceId, setEditingDeviceId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  const [showCompliance, setShowCompliance] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState([]);
  const [complianceFilterDeviceId, setComplianceFilterDeviceId] = useState("");

  const [activeTab, setActiveTab] = useState("devices");
  const [searchTerm, setSearchTerm] = useState("");

  // ✅ Refresh UX
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  const devices = useMemo(() => {
    const list = Object.values(devicesById).sort((a, b) => a.id.localeCompare(b.id));

    const q = String(searchTerm || "").trim().toLowerCase();
    if (!q) return list;

    return list.filter((d) => {
      const id = String(d.id || "").toLowerCase();
      const alias = String((aliasesById[d.id]?.label || "")).toLowerCase();
      const name = String(d.name || "").toLowerCase();
      return id.includes(q) || alias.includes(q) || name.includes(q);
    });
  }, [devicesById, searchTerm, aliasesById]);

  const kpi = useMemo(() => {
    let online = 0, offline = 0, conn = 0;
    for (const d of Object.values(devicesById)) {
      const o = isOnline(d);
      if (o) online += 1;
      else offline += 1;
    }
    return { online, offline, conn, total: Object.values(devicesById).length };
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
   * LOGIN / LOGOUT
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

  const logout = () => {
    try {
      wsRef.current?.close();
    } catch { }
    wsRef.current = null;

    setSelectedDeviceId(null);
    setEditingDeviceId(null);
    setEditingValue("");
    setShowCompliance(false);
    setComplianceEvents([]);
    setComplianceFilterDeviceId("");
    setDevicesById({});
    setLogs([]);
    setAliasesById({});
    setActiveTab("devices");
    setSearchTerm("");
    setIsRefreshing(false);
    setLastRefreshAt(null);

    setToken(null);
    setUser(null);
  };

  /**
   * ============================================
   * REST SNAPSHOT
   * ============================================
   */
  const fetchDevices = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/devices`, { headers });
    if (!res.ok) throw new Error("Falha ao buscar /api/devices");
    const list = await res.json();
    setDevicesById(arrayToMapById(list));
  };

  const fetchLogs = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/logs`, { headers });
    if (!res.ok) throw new Error("Falha ao buscar /api/logs");
    setLogs(await res.json());
  };

  const fetchAliases = async (authToken) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/device-aliases`, { headers });
    if (!res.ok) throw new Error("Falha ao buscar /api/device-aliases");

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

  const fetchComplianceEvents = async (authToken, deviceIdFilter) => {
    const headers = { Authorization: `Bearer ${authToken}` };
    const q = deviceIdFilter ? `?deviceId=${encodeURIComponent(deviceIdFilter)}` : "";
    const res = await fetch(`${HTTP_BASE}/api/compliance/events${q}`, { headers });
    if (!res.ok) throw new Error("Falha ao buscar /api/compliance/events");
    setComplianceEvents(await res.json());
  };

  const fetchData = async (authToken) => {
    if (!authToken) return;
    await Promise.all([fetchDevices(authToken), fetchLogs(authToken), fetchAliases(authToken)]);
  };

  /**
   * ============================================
   * REFRESH 
   * ============================================
   */
  const refreshAll = async () => {
    if (!token) return;
    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      await fetchData(token);

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "get_snapshot" }));
        } catch (e) {
          console.error("Erro ao enviar snapshot via WebSocket:", e);
        }
      }

      // se painel de compliance estiver aberto, atualiza também
      if (showCompliance) {
        await fetchComplianceEvents(token, complianceFilterDeviceId || "");
      }

      setLastRefreshAt(Date.now());
    } catch (e) {
      alert(`Falha ao atualizar: ${e.message || String(e)}`);
    } finally {
      setIsRefreshing(false);
    }
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
        // primeira carga: usa o refreshAll para ter feedback e consistência
        await refreshAll();
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "devices_snapshot" && Array.isArray(msg.devices)) {
          setDevicesById(arrayToMapById(msg.devices));
          return;
        }

        if (msg.type === "device_presence") {
          setDevicesById((prev) => applyPresencePatch(prev, msg));
          return;
        }

        if (msg.type === "consent_response") {
          alert(`Dispositivo ${msg.deviceId} ${msg.accepted ? "aceitou" : "recusou"} o suporte.`);
          fetchLogs(token).catch(() => { });

          if (msg.accepted) {
            setSelectedDeviceId(normId(msg.deviceId));
          }
          return;
        }

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
            fetchComplianceEvents(token, complianceFilterDeviceId || "").catch(() => { });
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
   * AÇÕES
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
    try {
      await fetchComplianceEvents(token, id);
    } catch (e) {
      alert(`Falha no compliance: ${e.message || String(e)}`);
    }
  };

  const refreshCompliance = async () => {
    try {
      await fetchComplianceEvents(token, complianceFilterDeviceId || "");
    } catch (e) {
      alert(`Falha no compliance: ${e.message || String(e)}`);
    }
  };

  const navigate = (tab) => {
    setActiveTab(tab);
    setSelectedDeviceId(null);
  };

  const lastRefreshLabel = lastRefreshAt ? new Date(lastRefreshAt).toLocaleTimeString() : "—";

  return (
    <>
      <BackgroundEye />

      <div className="app-layer">
        <div className="shell">
          {/* SIDEBAR */}
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-badge">👁️</div>
              LOOKOUT
            </div>

            <nav className="nav">
              <a
                className={activeTab === "devices" ? "active" : ""}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("devices");
                }}
              >
                Dispositivos
              </a>

              <a
                className={activeTab === "logs" ? "active" : ""}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("logs");
                }}
              >
                Logs
              </a>

              <a
                className={activeTab === "settings" ? "active" : ""}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("settings");
                }}
              >
                Configurações
              </a>
            </nav>

            <div className="sidebar-foot muted" style={{ marginTop: 12, fontSize: 12 }}>
              Backend: {HTTP_BASE}
              <div style={{ marginTop: 10 }}>
                <button className="btn" onClick={logout} title="Sair do admin e voltar ao login">
                  Sair
                </button>
              </div>
            </div>
          </aside>

          {/* TOPBAR */}
          <header className="topbar">
            <div className="title">
              MDM Console
              <div className="muted" style={{ fontSize: 12 }}>
                Bem-vindo {user?.username} • atualizado: {lastRefreshLabel}
              </div>
            </div>

            <div className="search">
              <input
                placeholder="Buscar por alias ou ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                disabled={activeTab !== "devices"}
                title={activeTab !== "devices" ? "Disponível na aba Dispositivos" : ""}
              />
            </div>

            <div className="user-pill">Admin</div>
          </header>

          {/* MAIN */}
          <main className="main">
            {activeTab === "devices" && (
              <>
                <div className="main-head">
                  <div>
                    <h1 className="h1">Dispositivos</h1>
                    <p className="sub">Gerencie computadores conectados e solicite suporte remoto.</p>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    <button
                      className={`btn ${showCompliance ? "red" : ""}`}
                      onClick={async () => {
                        const next = !showCompliance;
                        setShowCompliance(next);
                        if (next) {
                          setComplianceFilterDeviceId("");
                          try {
                            await fetchComplianceEvents(token, "");
                          } catch (e) {
                            alert(`Falha no compliance: ${e.message || String(e)}`);
                          }
                        }
                      }}
                    >
                      {showCompliance ? "Fechar Compliance" : "Compliance"}
                    </button>

                    <button className="btn" onClick={refreshAll} disabled={isRefreshing}>
                      {isRefreshing ? "Atualizando..." : "Atualizar"}
                    </button>
                  </div>
                </div>

                {/* KPI CARDS */}
                <section className="cards">
                  <div className="card">
                    <div className="kpi">{kpi.online}</div>
                    <div className="kpi-label">Online agora</div>
                  </div>
                  <div className="card">
                    <div className="kpi">{kpi.offline}</div>
                    <div className="kpi-label">Offline</div>
                  </div>
                  <div className="card">
                    <div className="kpi">{kpi.conn}</div>
                    <div className="kpi-label">Conectando</div>
                  </div>
                  <div className="card">
                    <div className="kpi">{kpi.total}</div>
                    <div className="kpi-label">Total</div>
                  </div>
                </section>

                {/* TABELA */}
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <div className="panel-title">Lista de dispositivos</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Clique em “Suporte” para solicitar acesso e “Ver tela” após autorização.
                      </div>
                    </div>
                  </div>

                  <table className="table">
                    <thead>
                      <tr>
                        <th>Alias / Nome</th>
                        <th>ID</th>
                        <th>Status</th>
                        <th>Compliance</th>
                        <th>Versão</th>
                        <th>Último</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((d) => {
                        const online = isOnline(d);
                        const displayName = getDisplayName(d);
                        const deviceId = d.id;
                        const isEditing = editingDeviceId === deviceId;

                        const flag = !!d.complianceFlag;
                        const count = Number(d.complianceCount || 0);

                        return (
                          <tr key={d.id}>
                            <td>
                              <div style={{ fontWeight: 700 }}>{displayName}</div>
                              {!isEditing && getAliasLabel(deviceId) ? (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  alias salvo
                                </div>
                              ) : null}
                            </td>

                            <td className="muted">{deviceId}</td>

                            <td>
                              <span className="badge">
                                <span className={`dot ${online ? "online" : "offline"}`} />
                                {online ? "Online" : "Offline"}
                              </span>
                            </td>

                            <td>
                              {flag ? (
                                <button className="badge-btn" onClick={() => openCompliancePanel(deviceId)} title="Ver eventos">
                                  ❗ {count > 0 ? `(${count})` : ""}
                                </button>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>

                            <td className="muted">{d.agentVersion ? `v${d.agentVersion}` : "—"}</td>

                            <td className="muted">
                              {d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "—"}
                              {flag && d.complianceLastSeverity ? (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {String(d.complianceLastSeverity)}
                                </div>
                              ) : null}
                            </td>

                            <td>
                              {!isEditing ? (
                                <div className="row" style={{ gap: 8 }}>
                                  <button className="btn red" onClick={() => requestSupport(d.id)} disabled={!online}>
                                    Suporte
                                  </button>
                                  <button className="btn" onClick={() => setSelectedDeviceId(d.id)} disabled={!online}>
                                    Ver tela
                                  </button>
                                  <button className="btn" onClick={() => startRename(d.id)}>
                                    Renomear
                                  </button>
                                </div>
                              ) : (
                                <div className="row" style={{ gap: 8 }}>
                                  <input
                                    className="inline-input"
                                    value={editingValue}
                                    onChange={(e) => setEditingValue(e.target.value)}
                                    placeholder="Ex: Loja 03 / Financeiro"
                                    autoFocus
                                  />
                                  <button className="btn red" onClick={() => saveRename(d.id)}>
                                    Salvar
                                  </button>
                                  <button className="btn" onClick={cancelRename}>
                                    Cancelar
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {devices.length === 0 && (
                        <tr>
                          <td colSpan={7} className="muted" style={{ padding: 16 }}>
                            Nenhum dispositivo encontrado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>

                {/* COMPLIANCE */}
                {showCompliance && (
                  <section className="panel" style={{ marginTop: 18 }}>
                    <div className="panel-head">
                      <div>
                        <div className="panel-title">Compliance</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          Fonte: {HTTP_BASE}/api/compliance/events
                        </div>
                      </div>

                      <div className="row" style={{ gap: 8 }}>
                        <input
                          className="inline-input"
                          value={complianceFilterDeviceId}
                          onChange={(e) => setComplianceFilterDeviceId(e.target.value)}
                          placeholder="Filtrar por deviceId (opcional)"
                          style={{ width: 260 }}
                        />
                        <button className="btn" onClick={refreshCompliance}>
                          Atualizar
                        </button>
                      </div>
                    </div>

                    <ul className="list">
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
                          <li key={id} className="list-item">
                            <div style={{ fontWeight: 800 }}>❗ {sev}</div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {ts}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <span style={{ fontWeight: 700 }}>
                                {dev}
                                {alias}
                              </span>{" "}
                              <span className="muted" style={{ fontSize: 12 }}>
                                | autor: {author}
                              </span>
                            </div>
                            <div style={{ marginTop: 6 }}>{content}</div>
                            {matches && (
                              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                                match: {matches}
                              </div>
                            )}
                          </li>
                        );
                      })}
                      {complianceEvents.length === 0 && <li className="muted">Nenhum evento encontrado.</li>}
                    </ul>
                  </section>
                )}

                {/* VIEWER */}
                <ScreenViewer
                  deviceId={selectedDeviceId}
                  displayName={selectedDisplayName}
                  onClose={() => setSelectedDeviceId(null)}
                />
              </>
            )}

            {activeTab === "logs" && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Logs</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Eventos do sistema
                    </div>
                  </div>
                  <button className="btn" onClick={refreshAll} disabled={isRefreshing}>
                    {isRefreshing ? "Atualizando..." : "Atualizar"}
                  </button>
                </div>

                <ul className="list">
                  {logs.map((log, i) => (
                    <li key={i} className="list-item">
                      <span className="muted">
                        {log?.timestamp ? String(log.timestamp) : log?.ts ? new Date(log.ts).toLocaleString() : ""}
                      </span>{" "}
                      — {log?.action ? log.action : log?.msg ? log.msg : JSON.stringify(log)}
                    </li>
                  ))}
                  {logs.length === 0 && <li className="muted">Sem logs no momento.</li>}
                </ul>
              </section>
            )}

            {activeTab === "settings" && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Configurações</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Tela administrativa (placeholder).
                    </div>
                  </div>
                  <button className="btn" onClick={refreshAll} disabled={isRefreshing}>
                    {isRefreshing ? "Atualizando..." : "Atualizar"}
                  </button>
                </div>

                <div style={{ padding: 14 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    Conexões atuais
                  </div>

                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <div className="card" style={{ minWidth: 260 }}>
                      <div className="kpi" style={{ fontSize: 18 }}>
                        {HTTP_BASE}
                      </div>
                      <div className="kpi-label">HTTP Backend</div>
                    </div>

                    <div className="card" style={{ minWidth: 260 }}>
                      <div className="kpi" style={{ fontSize: 18 }}>
                        {WS_BASE}
                      </div>
                      <div className="kpi-label">WS Backend</div>
                    </div>

                    <div className="card" style={{ minWidth: 260 }}>
                      <div className="kpi" style={{ fontSize: 18 }}>
                        {user?.username || "admin"}
                      </div>
                      <div className="kpi-label">Usuário logado</div>
                    </div>
                  </div>

                  <div className="muted" style={{ marginTop: 16, fontSize: 12 }}>
                    Última atualização manual: {lastRefreshLabel}
                  </div>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

export default App;
