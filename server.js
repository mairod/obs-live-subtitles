import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { makeCaptionStream } from './lib/captionStream.js';
import { makeTranslator, makeStreamingTranslator } from './lib/translate.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const ROUTES = { '/': '/capture.html', '/capture': '/capture.html', '/overlay': '/overlay.html' };

if (!process.env.ELEVENLABS_API_KEY) {
  console.warn('WARNING: ELEVENLABS_API_KEY not set — transcription will fail.');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  const file = path.normalize(path.join(PUBLIC, ROUTES[url] ?? url));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

const audioWss = new WebSocketServer({ noServer: true });
const captionWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const wss = { '/ws/audio': audioWss, '/ws/captions': captionWss }[new URL(req.url, 'http://x').pathname];
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcastCaption({ text, final }) {
  const data = JSON.stringify({ type: 'caption', text, final });
  for (const c of captionWss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

// ponytail: one stream for the whole server — single presenter, single overlay.
const captions = makeCaptionStream({
  translateStream: makeStreamingTranslator(),
  translate: makeTranslator(),
  emit: broadcastCaption,
});

// No language_code = Scribe auto-detects and follows mid-talk language
// switches, so English speech transcribes as English instead of being
// force-decoded into French gibberish. The translator then passes English
// through unchanged. ponytail: set SCRIBE_LANGUAGE=fr to pin it if
// detection drifts in a noisy room.
const SCRIBE_PARAMS = new URLSearchParams({
  model_id: 'scribe_v2_realtime',
  audio_format: 'pcm_16000',
  commit_strategy: 'vad',
  // Shorter silence → shorter segments → the provisional lane converges sooner.
  vad_silence_threshold_secs: process.env.VAD_SILENCE_SECS || '0.4',
  ...(process.env.SCRIBE_LANGUAGE && { language_code: process.env.SCRIBE_LANGUAGE }),
});

audioWss.on('connection', (browser) => {
  console.log('capture client connected — opening Scribe session');
  const scribe = new WebSocket(
    `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${SCRIBE_PARAMS}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } },
  );
  const pending = []; // audio received before Scribe socket opens

  const sendChunk = (buf) =>
    scribe.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: buf.toString('base64'),
      sample_rate: 16000,
    }));

  scribe.on('open', () => {
    console.log('Scribe session open');
    for (const buf of pending.splice(0)) sendChunk(buf);
  });

  const toBrowser = (obj) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(obj));
  };

  scribe.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.message_type === 'partial_transcript') {
      toBrowser({ type: 'partial', text: msg.text });
      captions.onPartial(msg.text);
    } else if (msg.message_type === 'committed_transcript') {
      toBrowser({ type: 'committed', text: msg.text });
      captions.onCommit(msg.text);
    } else if (msg.message_type !== 'session_started') {
      const log = msg.error || String(msg.message_type).includes('error') ? console.error : console.log;
      log('Scribe:', raw.toString());
    }
  });

  scribe.on('error', (err) => { console.error('Scribe socket error:', err.message); browser.close(); });
  scribe.on('close', (code) => {
    console.log('Scribe session closed', code);
    browser.close(); // capture page treats ws close as stop
  });

  browser.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (scribe.readyState === WebSocket.OPEN) sendChunk(data);
    else if (scribe.readyState === WebSocket.CONNECTING) {
      // ponytail: ~10s cap; drop oldest — realtime audio is worthless late
      if (pending.length >= 40) pending.shift();
      pending.push(data);
    }
  });
  browser.on('close', () => scribe.close());
});

server.listen(PORT, () => {
  console.log(`Capture page:  http://localhost:${PORT}/capture`);
  console.log(`OBS overlay:   http://localhost:${PORT}/overlay`);
});
