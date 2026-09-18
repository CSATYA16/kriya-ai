# 🔗 CarryOn V0.4 — Voice + Camera + Workspaces

Start a task on your phone using natural language, voice, or camera. Execute it on your laptop securely in real-time.

---

## What's New in V0.4
- **🎙️ Voice Input:** Tell CarryOn what you need using the microphone (Web Speech API).
- **📷 Camera Input:** Snap a photo of a document/notice to instantly extract a project workspace.
- **📁 `CREATE_WORKSPACE` Action:** A new secure, allowlisted action that sets up a full project directory complete with hardcoded `Research/`, `Assets/`, `Documentation/`, `Presentation/`, and `Tasks/` subfolders.
- **Phone-first UI Flow:** Camera integration falls back gracefully to a custom description prompt if OCR isn't available, providing a seamless mobile capture experience.

---

## Requirements

- **Node.js** ≥ 18  (`node --version`)
- **npm** ≥ 9
- Phone and laptop on the **same Wi-Fi network**
- HTTPS (or localhost) is required for Safari/Chrome to grant Microphone and Camera access. (Note: Since we are running locally without HTTPS, use `127.0.0.1` on your device if possible, or enable insecure origins for testing).

---

## 1. Installation

```bash
cd /Users/satya/.gemini/antigravity/scratch/carryon
npm install
```

---

## 2. Start the Server

In **Terminal tab 1**:

```bash
npm run server
```

You should see:
```
╔═══════════════════════════════════════╗
║   🔗 CarryOn Server v0.2/0.4          ║
╚═══════════════════════════════════════╝

  HTTP  → http://localhost:3000
  WS    → ws://localhost:3000

  📱 Open on phone: http://<MAC_IP>:3000
  🔍 Find your IP:  ipconfig getifaddr en0
```

---

## 3. Start the laptop Agent

In **Terminal tab 2**:

```bash
npm run agent
```

You should see:
```
╔═══════════════════════════════════════╗
║   🤖 CarryOn laptop Agent v0.4           ║
╚═══════════════════════════════════════╝

  Security: NO shell commands. fs/promises only.
  Allowlist: CREATE_FOLDER, CREATE_WORKSPACE on DESKTOP

[agent] Connected ✓
[agent] Registered as MAC_AGENT ✓  Waiting for approved actions…
```

---

## 4. Open CarryOn on Your Phone

Find your laptop's IP (`ipconfig getifaddr en0`).
On your phone's browser, navigate to:

```
http://<YOUR_MAC_IP>:3000
```

---

## 5. Testing V0.4 Features

### Test 1: Voice
1. Tap the 🎙️ **Microphone** icon.
2. Say: *"Create a workspace for my College Project"*
3. The transcript will be placed into the input box.
4. Tap Start Workflow → Approve.
5. Watch `~/Desktop/College_Project/` appear with 5 subfolders.

### Test 2: Camera
1. Tap the 📷 **Camera** icon.
2. Take a photo of an assignment sheet or project brief.
3. If OCR is unavailable, CarryOn provides a clean fallback asking you to name the workspace for this project.
4. Tap "Use Photo & Start".
5. The workspace is created after approval!

---

## Architecture

```
iPhone Browser            laptop Agent (Node.js)
  (index.html)               (mac-agent.js)
      |                           |
      |──── WebSocket ────────────|
      |                           |
      └──────── server.js ────────┘
                (HTTP + WS)
```

**Security model:**
- No arbitrary shell commands, scripts, or path traversals are allowed.
- Voice transcripts and Camera text fallbacks are still strictly parsed by the natural language intent engine.
- Phone approval is mandatory before any execution.

---

## Running Tests

```bash
npm test
```

All integration tests (including the new `CREATE_WORKSPACE` execution verification) should pass.

