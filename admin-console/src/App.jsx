import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [devices, setDevices] = useState([]);
  const [logs, setLogs] = useState([]);
  const ws = useRef(null);

  // Login
  const login = async (username, password) => {
    const res = await fetch('http://localhost:3001/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      const data = await res.json();
      setToken(data.token);
      setUser(data.user);
    } else {
      alert('Login falhou');
    }
  };

  // Buscar dispositivos e logs
  const fetchData = async () => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    const resDevices = await fetch('http://localhost:3001/api/devices', { headers });
    if (resDevices.ok) setDevices(await resDevices.json());

    const resLogs = await fetch('http://localhost:3001/api/logs', { headers });
    if (resLogs.ok) setLogs(await resLogs.json());
  };

  // WebSocket admin
  useEffect(() => {
    if (!token) return;
    ws.current = new WebSocket(`ws://localhost:3001?adminToken=${token}`);
    ws.current.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'consent_response') {
        alert(`Dispositivo ${msg.deviceId} ${msg.accepted ? 'aceitou' : 'recusou'} o suporte.`);
        fetchData();
      }
    };
    fetchData();
    return () => ws.current.close();
  }, [token]);

  const requestSupport = deviceId => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'request_remote_access', deviceId }));
    }
  };

  if (!token) return <LoginForm onLogin={login} />;

  return (
    <div>
      <h1>MDM Console - Bem-vindo {user.username}</h1>
      <h2>Dispositivos</h2>
      <ul>
        {devices.map(d => (
          <li key={d.id}>
            {d.name} ({d.user}) - {d.connected ? 'Online' : 'Offline'}
            <button onClick={() => requestSupport(d.id)} disabled={!d.connected}>Suporte</button>
          </li>
        ))}
      </ul>
      <h2>Logs</h2>
      <ul>
        {logs.map((log, i) => (
          <li key={i}>{log.timestamp} - {log.action}</li>
        ))}
      </ul>
    </div>
  );
}

function LoginForm({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); onLogin(username, password); }}>
      <h2>Login Admin</h2>
      <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Usuário" />
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Senha" />
      <button type="submit">Entrar</button>
    </form>
  );
}

export default App;
