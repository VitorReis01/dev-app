import React, { useEffect, useMemo, useRef, useState } from "react";
import BackgroundEye from "./components/BackgroundEye";
import "./app-shell.css";

// ✅ Assets (adicione os arquivos conforme instrução)
import imesulLogo from "./assets/imesul.png";
import vrCreator from "./assets/vr.png";

/**
 * ============================================
 * CONFIG (HTTP + WS) - AUTO-DETECT
 * ============================================
 * Objetivo: funcionar em qualquer PC só abrindo o link:
 *   http://IP_DO_SERVIDOR:3001
 * Sem depender de .env apontando pra "localhost".
 */
const FALLBACK_PORT = "3001";

function getBackendBaseFromWindow() {
  try {
    const { protocol, hostname, port, origin } = window.location;

    const isHttps = protocol === "https:";
    const wsProto = isHttps ? "wss" : "ws";

    const isLocal =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.");

    // 🌐 PRODUÇÃO (Cloudflare / HTTPS público)
    if (isHttps && !isLocal) {
      return {
        HTTP_BASE: origin,
        WS_BASE: `${wsProto}://${hostname}`,
      };
    }

    // 🖥️ LOCAL / LAN
    const p = port && String(port).trim() ? String(port).trim() : FALLBACK_PORT;

    return {
      HTTP_BASE: `${protocol}//${hostname}:${p}`,
      WS_BASE: `${wsProto}://${hostname}:${p}`,
    };
  } catch {
    return {
      HTTP_BASE: `http://localhost:${FALLBACK_PORT}`,
      WS_BASE: `ws://localhost:${FALLBACK_PORT}`,
    };
  }
}

const { HTTP_BASE, WS_BASE } = getBackendBaseFromWindow();

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
    },
  };
}

/**
 * ============================================
 * DETECT MOBILE (pra escolher MJPEG x FRAME)
 * ============================================
 */
function isProbablyMobile() {
  try {
    const ua = String(navigator.userAgent || "").toLowerCase();
    const byUa =
      ua.includes("android") ||
      ua.includes("iphone") ||
      ua.includes("ipad") ||
      ua.includes("ipod") ||
      ua.includes("mobile");

    // pointer coarse ajuda em tablets/celulares
    const byPointer = !!window.matchMedia?.("(pointer: coarse)")?.matches;

    return byUa || byPointer;
  } catch {
    return false;
  }
}

/**
 * ============================================
 * MiniModal (para "Criador")
 * ============================================
 */
function Modal({ open, title, onClose, children }) {
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 96vw)",
          borderRadius: 14,
          background: "rgba(18, 18, 22, .92)",
          border: "1px solid rgba(255,255,255,.10)",
          boxShadow: "0 20px 80px rgba(0,0,0,.65)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid rgba(255,255,255,.08)",
          }}
        >
          <div style={{ fontWeight: 800 }}>{title}</div>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>

        <div style={{ padding: 14 }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * ============================================
 * ScreenViewer (MJPEG desktop + FRAME mobile)
 * ============================================
 */
function ScreenViewer({ deviceId, displayName, onClose }) {
  const viewerRef = useRef(null);

  // ✅ modo padrão:
  // - mobile -> frame (polling)
  // - desktop -> mjpeg
  const [mode, setMode] = useState(() => (isProbablyMobile() ? "frame" : "mjpeg"));

  // tick usado para cache-busting no modo frame
  const [tick, setTick] = useState(0);

  // controla se o MJPEG falhou (pra cair no frame)
  const [mjpegFailed, setMjpegFailed] = useState(false);

  const token = localStorage.getItem("lookout_token") || "";

  const mjpegUrl = useMemo(() => {
    if (!deviceId) return "";
    return (
      `${HTTP_BASE}/api/devices/${encodeURIComponent(deviceId)}/mjpeg` +
      `?token=${encodeURIComponent(token)}`
    );
  }, [deviceId, token]);

  const frameUrl = useMemo(() => {
    if (!deviceId) return "";
    // ✅ cache-buster: t=...
    return (
      `${HTTP_BASE}/api/devices/${encodeURIComponent(deviceId)}/frame` +
      `?token=${encodeURIComponent(token)}` +
      `&t=${encodeURIComponent(String(tick))}`
    );
  }, [deviceId, token, tick]);

  // ✅ polling só no modo frame
  useEffect(() => {
    if (!deviceId) return;
    if (mode !== "frame") return;

    // 300ms ~= 3.3 fps (bom pra mobile e 4G/5G)
    const intervalMs = 300;
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [deviceId, mode]);

  // se MJPEG falhou, força modo frame (fallback automático)
  useEffect(() => {
    if (!deviceId) return;
    if (!mjpegFailed) return;
    setMode("frame");
  }, [deviceId, mjpegFailed]);

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
    setMjpegFailed(false);
    setTick(0);
    setMode(isProbablyMobile() ? "frame" : "mjpeg");
  };

  if (!deviceId) return null;

  const activeUrl = mode === "mjpeg" ? mjpegUrl : frameUrl;

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
            <span style={{ marginLeft: 10 }}>
              Modo: <b>{mode === "mjpeg" ? "MJPEG" : "FRAME"}</b>
              {mjpegFailed ? <span style={{ marginLeft: 8 }}>⚠️ MJPEG falhou, usando FRAME</span> : null}
            </span>
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={enterFullscreen}>
            Tela cheia
          </button>

          <button
            className="btn"
            onClick={exitFullscreen}
            title="Sai do fullscreen, mas mantém o viewer aberto"
          >
            Sair tela cheia
          </button>

          <button
            className="btn"
            onClick={() => {
              // alterna manualmente (útil pra testes)
              setMjpegFailed(false);
              setMode((m) => (m === "mjpeg" ? "frame" : "mjpeg"));
            }}
            title="Alterna MJPEG/FRAME"
          >
            Alternar modo
          </button>

          <button
            className="btn"
            onClick={closeViewer}
            title="Fecha o viewer e limpa a seleção"
          >
            Fechar
          </button>

          <button className="btn red" onClick={() => window.open(activeUrl, "_blank")}>
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
        <img
          src={activeUrl}
          alt="screen"
          className="viewer-img"
          onError={() => {
            // ✅ se MJPEG falhar (muito comum em mobile), cai pro frame automaticamente
            if (mode === "mjpeg") setMjpegFailed(true);
          }}
        />
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
            {/* ✅ Cabeçalho com LOGO IMESUL */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div className="login-brand">
                  <span className="logo-dot">👁️</span>
                  <span>LOOKOUT</span>
                </div>
                <div className="login-sub">Admin Console</div>
              </div>

              <img
                src={imesulLogo}
                alt="Imesul"
                style={{
                  height: 26,
                  opacity: 0.95,
                  filter: "drop-shadow(0 8px 20px rgba(0,0,0,.35))",
                }}
              />
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onLogin(username, password);
              }}
              style={{ marginTop: 10 }}
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
  const [token, setToken] = useState(() => localStorage.getItem("lookout_token") || "");
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("lookout_user") || "null");
    } catch {
      return null;
    }
  });

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

  // ✅ Modal criador
  const [showCreator, setShowCreator] = useState(false);

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
    let online = 0,
      offline = 0,
      conn = 0;
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

    localStorage.setItem("lookout_token", data.token || "");
    localStorage.setItem("lookout_user", JSON.stringify(data.user || null));

    setToken(data.token || "");
    setUser(data.user || null);
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

    localStorage.removeItem("lookout_token");
    localStorage.removeItem("lookout_user");
    setToken("");
    setUser(null);
  };

  /**
   * ============================================
   * REST SNAPSHOT
   * ============================================
   */
  const fetchDevices = async (authToken) => {
    if (!authToken) return;

    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/devices`, { headers });

    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) return;

    const list = await res.json();
    setDevicesById(arrayToMapById(list));
  };

  const fetchLogs = async (authToken) => {
    if (!authToken) return;

    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/logs`, { headers });

    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) return;

    setLogs(await res.json());
  };

  const fetchAliases = async (authToken) => {
    if (!authToken) return;

    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${HTTP_BASE}/api/device-aliases`, { headers });

    if (res.status === 401) {
      logout();
      return;
    }
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

  useEffect(() => {
    if (!token) return;
    fetchData(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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

  const navigate = (tab) => {
    setActiveTab(tab);
    setSelectedDeviceId(null);
  };

  /**
   * ============================================
   * UI
   * ============================================
   */
  return (
    <>
      <BackgroundEye />

      <Modal open={showCreator} title="Criador" onClose={() => setShowCreator(false)}>
        <div style={{ display: "grid", gap: 12 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Créditos do sistema (discreto, mas visível para quem procurar).
          </div>
          <img
            src={vrCreator}
            alt="Criador"
            style={{
              width: "100%",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,.10)",
            }}
          />
        </div>
      </Modal>

      <div className="app-layer">
        <div className="shell">
          {/* SIDEBAR */}
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-badge">👁️</div>
              LOOKOUT
            </div>

            {/* ✅ NAV sem <a href="#"> pra não gerar warning */}
            <nav className="nav">
              <button type="button" className={activeTab === "devices" ? "active" : ""} onClick={() => navigate("devices")}>
                Dispositivos
              </button>

              <button type="button" className={activeTab === "logs" ? "active" : ""} onClick={() => navigate("logs")}>
                Logs
              </button>

              <button type="button" className={activeTab === "settings" ? "active" : ""} onClick={() => navigate("settings")}>
                Configurações
              </button>
            </nav>

            {/* ✅ Rodapé com LOGO IMESUL + crédito do criador */}
            <div className="sidebar-foot muted" style={{ marginTop: 12, fontSize: 12 }}>
              Backend: {HTTP_BASE}

              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
                <img
                  src={imesulLogo}
                  alt="Imesul"
                  style={{
                    height: 22,
                    opacity: 0.92,
                    filter: "drop-shadow(0 10px 20px rgba(0,0,0,.35))",
                  }}
                />

                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowCreator(true)}
                  title="Créditos do criador"
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    opacity: 0.92,
                  }}
                >
                  Criador
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn" onClick={logout} title="Sair do admin e voltar ao login">
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
                Bem-vindo {user?.username}
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
            {/* ABA DISPOSITIVOS */}
            {activeTab === "devices" && (
              <>
                <div className="main-head">
                  <div>
                    <h1 className="h1">Dispositivos</h1>
                    <p className="sub">Gerencie computadores conectados e solicite suporte remoto.</p>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className={`btn ${showCompliance ? "red" : ""}`}
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

                    <button type="button" className="btn" onClick={() => fetchData(token)}>
                      Atualizar
                    </button>
                  </div>
                </div>

                {/* KPI */}
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
                                <button type="button" className="badge-btn" onClick={() => openCompliancePanel(deviceId)} title="Ver eventos">
                                  ❗ {count > 0 ? `(${count})` : ""}
                                </button>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>

                            <td className="muted">{d.agentVersion ? `v${d.agentVersion}` : "—"}</td>

                            <td className="muted">{d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "—"}</td>

                            <td>
                              {!isEditing ? (
                                <div className="row" style={{ gap: 8 }}>
                                  <button type="button" className="btn red" onClick={() => requestSupport(d.id)} disabled={!online}>
                                    Suporte
                                  </button>
                                  <button type="button" className="btn" onClick={() => setSelectedDeviceId(d.id)} disabled={!online}>
                                    Ver tela
                                  </button>
                                  <button type="button" className="btn" onClick={() => startRename(d.id)}>
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
                                  <button type="button" className="btn red" onClick={() => saveRename(d.id)}>
                                    Salvar
                                  </button>
                                  <button type="button" className="btn" onClick={cancelRename}>
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
                        <button type="button" className="btn" onClick={refreshCompliance}>
                          Atualizar
                        </button>
                      </div>
                    </div>

                    <ul className="list">
                      {complianceEvents.map((ev) => {
                        const id = ev?.id || `${ev?.timestamp || ""}`;
                        const ts = ev?.timestamp ? new Date(ev.timestamp).toLocaleString() : "";
                        const dev = ev?.deviceId || "";
                        const sev = ev?.severity ? String(ev.severity) : "";
                        const content = ev?.content ? String(ev.content) : "";

                        return (
                          <li key={id} className="list-item">
                            <div style={{ fontWeight: 800 }}>❗ {sev}</div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {ts}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <span style={{ fontWeight: 700 }}>{dev}</span>
                            </div>
                            <div style={{ marginTop: 6 }}>{content}</div>
                          </li>
                        );
                      })}
                      {complianceEvents.length === 0 && <li className="muted">Nenhum evento encontrado.</li>}
                    </ul>
                  </section>
                )}

                {/* VIEWER */}
                <ScreenViewer deviceId={selectedDeviceId} displayName={selectedDisplayName} onClose={() => setSelectedDeviceId(null)} />
              </>
            )}

            {/* ABA LOGS */}
            {activeTab === "logs" && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Logs</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Eventos do sistema
                    </div>
                  </div>
                  <button type="button" className="btn" onClick={() => fetchLogs(token)}>
                    Atualizar logs
                  </button>
                </div>

                <ul className="list">
                  {logs.map((log, i) => (
                    <li key={i} className="list-item">
                      <span className="muted">{String(log.timestamp || log.ts || "")}</span> —{" "}
                      {log.action ? log.action : log.msg ? log.msg : JSON.stringify(log)}
                    </li>
                  ))}
                  {logs.length === 0 && <li className="muted">Sem logs no momento.</li>}
                </ul>
              </section>
            )}

            {/* ABA SETTINGS */}
            {activeTab === "settings" && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <div className="panel-title">Configurações</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Área administrativa (placeholder)
                    </div>
                  </div>
                </div>

                <div style={{ padding: 14 }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Cliente: <b>Imesul Distribuição</b>
                  </div>

                  <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
                    <img src={imesulLogo} alt="Imesul" style={{ height: 32, opacity: 0.95 }} />
                    <button type="button" className="btn" onClick={() => setShowCreator(true)}>
                      Ver créditos do criador
                    </button>
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
