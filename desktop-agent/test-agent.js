const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');

const deviceId = 'agent-local-01';
const FPS = 10;
let streaming = false;

const ws = new WebSocket(
  'ws://localhost:3010?role=agent&deviceId=' + deviceId
);

ws.on('open', () => {
  console.log('🟢 Agent conectado (streaming)');
});

ws.on('message', async (data) => {
  let msg;

  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (msg.type === 'view_request') {
    console.log('📺 Streaming solicitado');

    if (!streaming) {
      streaming = true;

      //  CONFIRMA PARA O BACKEND / ADMIN
      ws.send(JSON.stringify({
        type: 'view_accepted',
        deviceId
      }));

      startStreaming();
    }
  }

  if (msg.type === 'stop_view') {
    streaming = false;
    console.log('⏹ Streaming parado');
  }
});

async function startStreaming() {
  while (streaming && ws.readyState === WebSocket.OPEN) {
    try {
      const img = await screenshot({ format: 'jpeg' });

      ws.send(JSON.stringify({
        type: 'screen_frame',
        deviceId,
        image: img.toString('base64')
      }));

      console.log('🖼 Frame enviado');
      await sleep(1000 / FPS);

    } catch (err) {
      console.error('❌ Erro ao capturar tela:', err.message);
      streaming = false;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
