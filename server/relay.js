'use strict';
/**
 * KRIYA Relay Server v1.0
 *
 * A secure WebSocket relay that routes messages between paired Mac agents
 * and phone clients over the internet.
 *
 * IMPORTANT: The relay only ROUTES messages — it NEVER executes code,
 * accesses filesystems, or modifies data. Full KRIYA security model preserved.
 *
 * Protocol:
 *   Mac Agent → Relay:
 *     REGISTER_MAC       { type, macName? }
 *     REQUEST_PAIRING    { type, sessionToken? } — generate QR pairing data
 *     RELAY_MSG          { type, sessionToken, payload } — forward to phone
 *     MAC_DISCONNECT     { type, sessionToken }
 *
 *   Phone → Relay:
 *     PAIR_REQUEST       { type, pairingToken } — claim a pairing
 *     RELAY_MSG          { type, sessionToken, payload } — forward to Mac
 *     PHONE_DISCONNECT   { type, sessionToken }
 *
 *   Relay → Both:
 *     PAIRING_READY      { type, token, shortCode, pairingUrl, qrAscii } → Mac
 *     PAIR_CONFIRM       { type, sessionToken, macName, pairedAt }
 *     RELAY_MSG          { type, payload }     — forwarded message
 *     RELAY_ERROR        { type, error }
 *     PEER_DISCONNECTED  { type, reason }
 */

const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto  = require('crypto');
const QRCode  = require('qrcode');

const {
  generatePairingToken,
  consumePairingToken,
  createSession,
  validateSession,
  removeSession,
  findSessionByConnId,
  cleanupConnection,
} = require('./pairing');

const PORT        = process.env.KRIYA_RELAY_PORT || 3100;
const RELAY_HOST  = process.env.KRIYA_RELAY_HOST || `http://localhost:${PORT}`;
const RELAY_AUTH  = process.env.KRIYA_RELAY_AUTH || '';  // optional pre-shared key for Mac

// Rate limiting: pairing attempts per IP
const pairingAttempts = new Map(); // ip → { count, resetAt }
const RATE_LIMIT      = 10;        // max attempts per minute per IP
const RATE_WINDOW_MS  = 60_000;

// Active connections: connId → WebSocket
const connections = new Map();

let connCounter = 0;
function newConnId() { return `conn-${++connCounter}-${Date.now()}`; }

// ─── HTTP server (health check + pairing URL handler) ─────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', relay: 'KRIYA Relay v1.0' }));
    return;
  }
  // Phone browser hits /pair/<token> → redirect to phone app with token
  const pairMatch = req.url.match(/^\/pair\/([a-f0-9]{32})$/);
  if (pairMatch) {
    const token = pairMatch[1];
    // Redirect to phone app with token as query param
    res.writeHead(302, { Location: `/?pairingToken=${token}` });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('KRIYA Relay — Not Found');
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const connId = newConnId();
  const ip     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  connections.set(connId, ws);
  ws._kriyaConnId = connId;

  console.log(`[relay] Connected: ${connId} (${ip})`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      send(ws, { type: 'RELAY_ERROR', error: 'Invalid JSON' });
      return;
    }

    const { type } = msg;

    // ── Mac Agent: REGISTER_MAC ──────────────────────────────────────────────
    if (type === 'REGISTER_MAC') {
      // Optional auth check
      if (RELAY_AUTH && msg.relayAuth !== RELAY_AUTH) {
        send(ws, { type: 'RELAY_ERROR', error: 'Unauthorized' });
        ws.close();
        return;
      }
      ws._role    = 'MAC_AGENT';
      ws._macName = msg.macName || 'My Mac';
      send(ws, { type: 'REGISTERED', role: 'MAC_AGENT', connId });
      console.log(`[relay] MAC_AGENT registered: ${connId} — "${ws._macName}"`);
      return;
    }

    // ── Mac Agent: REQUEST_PAIRING ───────────────────────────────────────────
    if (type === 'REQUEST_PAIRING') {
      if (ws._role !== 'MAC_AGENT') {
        send(ws, { type: 'RELAY_ERROR', error: 'Only MAC_AGENT can request pairing' });
        return;
      }
      const { token, shortCode } = generatePairingToken(connId, ws._macName);
      const pairingUrl = `${RELAY_HOST}/pair/${token}`;
      // Generate QR as text (terminal-friendly)
      let qrAscii = '';
      try { qrAscii = await QRCode.toString(pairingUrl, { type: 'utf8', small: true }); } catch {}

      ws._pairingToken = token;
      send(ws, {
        type: 'PAIRING_READY',
        token,
        shortCode,
        pairingUrl,
        qrAscii,
        expiresIn: 300, // seconds
      });
      console.log(`[relay] Pairing QR generated for ${connId}: code ${shortCode}`);
      return;
    }

    // ── Phone: PAIR_REQUEST ──────────────────────────────────────────────────
    if (type === 'PAIR_REQUEST') {
      // Rate limit
      if (!_checkRateLimit(ip)) {
        send(ws, { type: 'RELAY_ERROR', error: 'Too many pairing attempts. Try again later.' });
        return;
      }

      const { pairingToken } = msg;
      if (!pairingToken || typeof pairingToken !== 'string') {
        send(ws, { type: 'RELAY_ERROR', error: 'Invalid pairing token' });
        return;
      }

      const entry = consumePairingToken(pairingToken); // one-time use
      if (!entry) {
        send(ws, { type: 'RELAY_ERROR', error: 'Pairing token invalid or expired' });
        return;
      }

      const macWs = connections.get(entry.macConnId);
      if (!macWs || macWs.readyState !== WebSocket.OPEN) {
        send(ws, { type: 'RELAY_ERROR', error: 'Mac is no longer connected' });
        return;
      }

      // Create session
      ws._role = 'PHONE_CLIENT';
      const sessionToken = createSession({
        macConnId:  entry.macConnId,
        phoneConnId: connId,
        macName:    entry.macName,
      });
      ws._sessionToken  = sessionToken;
      macWs._sessionToken = sessionToken;

      const session = validateSession(sessionToken);
      const confirmPayload = {
        type: 'PAIR_CONFIRM',
        sessionToken,
        macName:   session.macName,
        pairedAt:  session.pairedAt,
      };

      // Notify both
      send(macWs, confirmPayload);
      send(ws,    confirmPayload);
      console.log(`[relay] PAIRED: mac=${entry.macConnId} phone=${connId} session=${sessionToken.slice(0,8)}…`);
      return;
    }

    // ── RELAY_MSG (either direction) ──────────────────────────────────────────
    if (type === 'RELAY_MSG') {
      const { sessionToken, payload } = msg;
      if (!sessionToken || !payload) {
        send(ws, { type: 'RELAY_ERROR', error: 'RELAY_MSG requires sessionToken and payload' });
        return;
      }

      const session = validateSession(sessionToken);
      if (!session) {
        send(ws, { type: 'RELAY_ERROR', error: 'Invalid or expired session' });
        return;
      }

      // Validate payload is an object (no arbitrary code)
      if (typeof payload !== 'object' || payload === null) {
        send(ws, { type: 'RELAY_ERROR', error: 'Payload must be a JSON object' });
        return;
      }

      // Route: Mac → Phone or Phone → Mac
      let targetConnId;
      if (connId === session.macConnId)  targetConnId = session.phoneConnId;
      else if (connId === session.phoneConnId) targetConnId = session.macConnId;
      else {
        send(ws, { type: 'RELAY_ERROR', error: 'Connection not in this session' });
        return;
      }

      const targetWs = connections.get(targetConnId);
      if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
        send(ws, { type: 'RELAY_ERROR', error: 'Peer is not connected' });
        return;
      }

      // Forward — relay is transparent; payload is delivered as-is
      send(targetWs, { type: 'RELAY_MSG', payload });
      return;
    }

    // ── Disconnect ────────────────────────────────────────────────────────────
    if (type === 'MAC_DISCONNECT' || type === 'PHONE_DISCONNECT') {
      const { sessionToken } = msg;
      if (sessionToken) {
        const session = validateSession(sessionToken);
        if (session) {
          // Notify the peer
          const peerConnId = connId === session.macConnId ? session.phoneConnId : session.macConnId;
          const peerWs = connections.get(peerConnId);
          if (peerWs && peerWs.readyState === WebSocket.OPEN)
            send(peerWs, { type: 'PEER_DISCONNECTED', reason: 'Device disconnected' });
          removeSession(sessionToken);
        }
      }
      ws.close();
      return;
    }

    send(ws, { type: 'RELAY_ERROR', error: `Unknown message type: ${type}` });
  });

  ws.on('close', () => {
    console.log(`[relay] Disconnected: ${connId}`);
    connections.delete(connId);
    // Notify peer if in a session
    const session = findSessionByConnId(connId);
    if (session) {
      const peerConnId = connId === session.macConnId ? session.phoneConnId : session.macConnId;
      const peerWs = connections.get(peerConnId);
      if (peerWs && peerWs.readyState === WebSocket.OPEN)
        send(peerWs, { type: 'PEER_DISCONNECTED', reason: 'Peer disconnected' });
    }
    cleanupConnection(connId);
  });

  ws.on('error', (err) => {
    console.error(`[relay] Error on ${connId}: ${err.message}`);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

function _checkRateLimit(ip) {
  const now = Date.now();
  const entry = pairingAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    pairingAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║   ⚡ KRIYA Relay v1.0                     ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`\n  WebSocket : ws://localhost:${PORT}`);
    console.log(`  Pairing   : ${RELAY_HOST}/pair/<token>`);
    console.log(`  Health    : ${RELAY_HOST}/health`);
    console.log('\n  Security: Relay ONLY routes — no code execution, no filesystem access.');
    console.log('  All KRIYA action validation happens on the Mac Agent.\n');
  });
}

module.exports = { httpServer, wss, PORT };
