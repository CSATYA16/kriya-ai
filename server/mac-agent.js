'use strict';
/**
 * KRIYA Mac Agent v1.0
 *
 * Two modes:
 *   --local  (default): Connect directly to local KRIYA server (ws://localhost:3000)
 *   --relay :           Connect outbound to KRIYA Relay, show QR pairing code,
 *                       accept commands from paired phone over internet.
 *
 * In BOTH modes the same security model applies:
 *   - Only allowlisted actions execute
 *   - NO shell commands, NO exec(), NO spawn()
 *   - Content is DATA — fs.writeFile() only, never executed
 *   - All path traversal guards active
 *
 * Allowlist:
 *   CREATE_FOLDER      location=DESKTOP or WORKSPACE
 *   CREATE_WORKSPACE   location=DESKTOP
 *   CREATE_TEXT_FILE   location=WORKSPACE only (.md/.txt)
 */

const { WebSocket } = require('ws');
const fs   = require('fs/promises');
const os   = require('os');
const path = require('path');

// ─── Mode detection ───────────────────────────────────────────────────────────
const USE_RELAY       = process.argv.includes('--relay');
const LOCAL_URL       = process.env.CARRYON_SERVER     || 'ws://localhost:3000';
const RELAY_URL       = process.env.KRIYA_RELAY_URL    || 'ws://localhost:3100';
const RELAY_AUTH      = process.env.KRIYA_RELAY_AUTH   || '';
const MAC_NAME        = process.env.KRIYA_MAC_NAME     || require('os').hostname().split('.')[0] || 'My Mac';
const RECONNECT_DELAY = 3000;

// ─── Security constants ───────────────────────────────────────────────────────
const SAFE_NAME_RE       = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const SAFE_FILE_NAME_RE  = /^[a-zA-Z0-9_\-. ]{1,100}$/;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const MAX_FILE_NAME_LENGTH = 100;
const MAX_CONTENT_LENGTH   = 10_000;

// ─── Location resolvers ───────────────────────────────────────────────────────
const LOCATION_RESOLVERS = {
  DESKTOP: () => path.join(os.homedir(), 'Desktop'),
};

function resolveBase(action) {
  if (action.location === 'WORKSPACE') {
    const wr = action.workspaceRoot;
    if (!wr || typeof wr !== 'string') throw new Error('WORKSPACE action missing workspaceRoot.');
    const desktopPath = path.join(os.homedir(), 'Desktop');
    const resolved = path.resolve(wr);
    if (!resolved.startsWith(desktopPath + path.sep) && resolved !== desktopPath)
      throw new Error('workspaceRoot is outside Desktop. Action rejected.');
    return resolved;
  }
  const resolver = LOCATION_RESOLVERS[action.location];
  if (!resolver) throw new Error(`Location "${action.location}" is not allowed.`);
  return resolver();
}

// ─── Action executor ──────────────────────────────────────────────────────────
async function executeAction(action, onProgress) {
  if (!action || typeof action !== 'object') throw new Error('Invalid action payload.');

  const { type } = action;

  // ── CREATE_FOLDER ──────────────────────────────────────────────────────────
  if (type === 'CREATE_FOLDER') {
    const { name } = action;
    if (!name || !SAFE_NAME_RE.test(name)) throw new Error(`Folder name "${name}" is invalid.`);

    const basePath   = resolveBase(action);
    const folderName = name.replace(/\s+/g, '_');
    const folderPath = path.join(basePath, folderName);

    if (!folderPath.startsWith(basePath + path.sep) && folderPath !== basePath)
      throw new Error('Path traversal detected. Action rejected.');
    const desktopPath = path.join(os.homedir(), 'Desktop');
    if (!folderPath.startsWith(desktopPath + path.sep) && folderPath !== desktopPath)
      throw new Error('Target path is outside Desktop. Action rejected.');

    if (onProgress) onProgress({ step: 1, total: 1, label: `Create ${folderName}` });
    await fs.mkdir(folderPath, { recursive: true });
    console.log(`[agent] Created folder: ${folderPath}`);
    return { message: `Folder "${folderName}" created at ${folderPath}`, path: folderPath };
  }

  // ── CREATE_WORKSPACE ───────────────────────────────────────────────────────
  if (type === 'CREATE_WORKSPACE') {
    const { name } = action;
    if (!name || !SAFE_NAME_RE.test(name)) throw new Error(`Workspace name "${name}" is invalid.`);

    const resolver = LOCATION_RESOLVERS[action.location];
    if (!resolver) throw new Error(`Location "${action.location}" is not allowed for CREATE_WORKSPACE.`);

    const basePath   = resolver();
    const folderName = name.replace(/\s+/g, '_');
    const folderPath = path.join(basePath, folderName);

    if (!folderPath.startsWith(basePath + path.sep) && folderPath !== basePath)
      throw new Error('Path traversal detected. Action rejected.');

    console.log(`[agent] Received approved action: CREATE_WORKSPACE`);
    console.log(`[agent] Workspace: ${folderName}`);
    console.log(`[agent] Creating: ${folderPath}`);

    if (onProgress) onProgress({ step: 1, total: 6, label: 'Create project workspace' });
    await fs.mkdir(folderPath, { recursive: true });

    const subdirs = ['Research', 'Assets', 'Documentation', 'Presentation', 'Tasks'];
    const createdFolders = [];
    for (let i = 0; i < subdirs.length; i++) {
      const sub = subdirs[i];
      if (onProgress) onProgress({ step: i + 2, total: 6, label: `Create ${sub} folder` });
      await fs.mkdir(path.join(folderPath, sub), { recursive: true });
      console.log(`[agent] Created: ${sub}`);
      createdFolders.push(sub);
    }

    return { message: `Workspace "${folderName}" prepared at ${folderPath}`, path: folderPath, createdFolders };
  }

  // ── CREATE_TEXT_FILE (.md / .txt, WORKSPACE only) ─────────────────────────
  if (type === 'CREATE_TEXT_FILE') {
    const { name, content } = action;

    if (action.location !== 'WORKSPACE')
      throw new Error('CREATE_TEXT_FILE requires location "WORKSPACE".');
    if (!name || typeof name !== 'string')
      throw new Error('CREATE_TEXT_FILE: file name is missing.');
    if (name.length > MAX_FILE_NAME_LENGTH)
      throw new Error(`CREATE_TEXT_FILE: file name too long (max ${MAX_FILE_NAME_LENGTH} chars).`);
    if (!SAFE_FILE_NAME_RE.test(name))
      throw new Error(`CREATE_TEXT_FILE: file name "${name}" contains invalid characters.`);
    if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('~'))
      throw new Error(`CREATE_TEXT_FILE: file name "${name}" contains path traversal characters.`);

    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.has(ext))
      throw new Error(`CREATE_TEXT_FILE: extension "${ext}" is not allowed. Only .md or .txt.`);

    if (typeof content !== 'string')
      throw new Error('CREATE_TEXT_FILE: content must be a string.');
    if (content.length > MAX_CONTENT_LENGTH)
      throw new Error(`CREATE_TEXT_FILE: content too long (max ${MAX_CONTENT_LENGTH}).`);
    if (content.includes('\0'))
      throw new Error('CREATE_TEXT_FILE: content contains null bytes.');

    const basePath = resolveBase(action);
    const filePath = path.join(basePath, name);

    if (!filePath.startsWith(basePath + path.sep) && filePath !== basePath)
      throw new Error('CREATE_TEXT_FILE: path traversal detected.');
    const desktopPath = path.join(os.homedir(), 'Desktop');
    if (!filePath.startsWith(desktopPath + path.sep))
      throw new Error('CREATE_TEXT_FILE: target path is outside Desktop.');

    if (onProgress) onProgress({ step: 1, total: 1, label: `Create ${name}` });

    // Content is DATA only — never executed
    await fs.writeFile(filePath, content, 'utf8');
    console.log(`[agent] Created file: ${filePath}`);
    return { message: `File "${name}" created at ${filePath}`, path: filePath };
  }

  throw new Error(`Action type "${type}" is not in the allowlist.`);
}

// ─── Message handler (shared between local and relay modes) ───────────────────
function createActionHandler(sendFn) {
  return async (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
      const { requestId, action } = msg;
      console.log(`[agent] Received action [${requestId}]:`, action.type, action.name);
      try {
        const result = await executeAction(action, (prog) => {
          sendFn({ type: 'ACTION_PROGRESS', requestId, ...prog });
        });
        console.log(`[agent] ✓ Success: ${result.message}`);
        sendFn({
          type: 'ACTION_RESULT',
          requestId,
          success: true,
          message: result.message,
          path: result.path,
          createdFolders: result.createdFolders,
        });
      } catch (err) {
        console.error(`[agent] ✗ Error: ${err.message}`);
        sendFn({
          type: 'ACTION_RESULT',
          requestId,
          success: false,
          message: err.message,
        });
      }
    }
  };
}

// ─── LOCAL MODE (direct WebSocket to server:3000) ─────────────────────────────
function connectLocal() {
  const SERVER_URL = LOCAL_URL;
  let ws;
  let reconnectTimer;

  function connect() {
    clearTimeout(reconnectTimer);
    console.log(`[agent] LOCAL MODE — Connecting to ${SERVER_URL} …`);
    ws = new WebSocket(SERVER_URL);
    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const handleAction = createActionHandler(send);

    ws.on('open', () => {
      console.log('[agent] Connected ✓');
      ws.send(JSON.stringify({ type: 'REGISTER', role: 'MAC_AGENT' }));
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'REGISTERED') {
        console.log('[agent] Registered as MAC_AGENT ✓  Waiting for approved actions…\n');
        return;
      }
      await handleAction(msg);
    });

    ws.on('close', (code) => {
      console.log(`[agent] Disconnected (${code}). Reconnecting in ${RECONNECT_DELAY/1000}s…`);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    });
    ws.on('error', (err) => console.error(`[agent] Error: ${err.message}`));
  }

  connect();
}

// ─── RELAY MODE (outbound to relay, QR pairing) ───────────────────────────────
function connectRelay() {
  let ws;
  let reconnectTimer;
  let sessionToken = null;
  let paired       = false;

  function connect() {
    clearTimeout(reconnectTimer);
    console.log(`[agent] RELAY MODE — Connecting to ${RELAY_URL} …`);
    ws = new WebSocket(RELAY_URL);

    // Send via relay (wraps payload in RELAY_MSG)
    function sendRelay(obj) {
      if (!sessionToken || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'RELAY_MSG', sessionToken, payload: obj }));
    }

    // Send directly to relay (registration, pairing)
    function sendDirect(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    const handleAction = createActionHandler(sendRelay);

    ws.on('open', () => {
      console.log('[agent] Relay connected ✓');
      // Register as Mac agent
      sendDirect({ type: 'REGISTER_MAC', macName: MAC_NAME, relayAuth: RELAY_AUTH });
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Direct relay messages
      if (msg.type === 'REGISTERED') {
        console.log('[agent] Registered with relay ✓\n');
        // Request pairing QR
        sendDirect({ type: 'REQUEST_PAIRING' });
        return;
      }

      if (msg.type === 'PAIRING_READY') {
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║   📱 KRIYA — Connect a Device              ║');
        console.log('╚═══════════════════════════════════════════╝\n');
        if (msg.qrAscii) {
          console.log(msg.qrAscii);
        }
        console.log(`  Pairing URL  : ${msg.pairingUrl}`);
        console.log(`  Short Code   : ${msg.shortCode}`);
        console.log(`  Expires in   : ${msg.expiresIn}s`);
        console.log('\n  Status: Waiting for device…\n');
        return;
      }

      if (msg.type === 'PAIR_CONFIRM') {
        sessionToken = msg.sessionToken;
        paired       = true;
        console.log('\n  ✅ Phone Connected!');
        console.log(`  Mac    : ${MAC_NAME}`);
        console.log(`  Paired : ${msg.pairedAt}`);
        console.log('\n  Status: ● Ready for commands\n');
        return;
      }

      if (msg.type === 'RELAY_ERROR') {
        console.error(`[agent] Relay error: ${msg.error}`);
        return;
      }

      if (msg.type === 'PEER_DISCONNECTED') {
        console.log('\n  📵 Phone disconnected. Generating new pairing QR…\n');
        paired = false;
        sessionToken = null;
        sendDirect({ type: 'REQUEST_PAIRING' });
        return;
      }

      // Wrapped relay messages from phone
      if (msg.type === 'RELAY_MSG' && msg.payload) {
        await handleAction(msg.payload);
        return;
      }
    });

    ws.on('close', (code) => {
      console.log(`[agent] Relay disconnected (${code}). Reconnecting in ${RECONNECT_DELAY/1000}s…`);
      paired = false; sessionToken = null;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    });

    ws.on('error', (err) => console.error(`[agent] Relay error: ${err.message}`));
  }

  connect();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════╗');
console.log('║   ⚡ KRIYA Mac Agent v1.0                 ║');
console.log(`║   Mode: ${USE_RELAY ? 'RELAY (remote)          ' : 'LOCAL (direct)          '}    ║`);
console.log('╚═══════════════════════════════════════════╝');
console.log('\n  Security: NO shell commands. fs/promises only. Content is DATA — never executed.');
console.log('  Allowlist: CREATE_FOLDER, CREATE_WORKSPACE, CREATE_TEXT_FILE (.md/.txt, WORKSPACE only)\n');

if (USE_RELAY) {
  connectRelay();
} else {
  connectLocal();
}

// Export for testing
module.exports = { executeAction };
