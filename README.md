# KRIYA
### From Intent to Action

KRIYA is a phone-first AI productivity system that turns natural-language intent into safe, structured, approved actions on your laptop. It understands what you want to accomplish, plans a workflow using a local AI model, and only executes that workflow after you review and approve it.

> KRIYA doesn't just understand what you want to do. It turns your intent into an actionable workflow, asks for approval, and executes the approved work on your laptop.

[![Tests](https://img.shields.io/badge/tests-227%20passed-brightgreen)](#running-tests)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

---

## ✨ What KRIYA Does

| Feature | Description |
|---|---|
| 🗣️ Natural-language requests | Type what you want in plain English |
| 🎙️ Voice input | Dictate your request using the microphone |
| 📷 Camera input + OCR | Photograph a document to extract project context |
| 🤖 Local AI workflow planning | Ollama + llama3.2:3b plans a structured multi-step workflow |
| 🔀 Deterministic fallback | Works without AI — uses built-in workflow templates if the model is unavailable |
| 👁️ Workflow preview | Review the full plan before anything happens |
| ✅ Human approval | Nothing executes until you tap Approve |
| 📁 Workspace creation | Creates full project directory structures on your laptop |
| 📝 Text file creation | Creates Markdown and text files inside workspaces |
| ⚡ Live progress | Watch each step execute in real time |
| 📱 Device pairing | Pair your phone to your laptop over a relay |
| 🌍 Remote relay connectivity | Control your laptop from outside your local network |
| 🔒 Session authentication | Cryptographic session tokens authenticate every relay session |

---

## 🧠 How It Works

```
📱 Phone
   │  Natural-language request (text, voice, or camera)
   ▼
🖥️  KRIYA Server
   │  Receives and forwards to AI planner
   ▼
🤖 Local AI Planner  (Ollama + llama3.2:3b)
   │  Parses intent → structured workflow steps
   ▼
📋 Structured Workflow
   │  Array of typed, named, located actions
   ▼
🛡️  Validation
   │  Schema + allowlist check before showing to user
   ▼
👤 Human Approval
   │  User reviews and taps Approve or Cancel
   ▼
🔁 Relay  (local or remote)
   │  Routes the approved workflow to the laptop agent
   ▼
💻 Laptop Agent  (mac-agent.js)
   │  Receives each step — validates again before touching disk
   ▼
✅ Allowlisted Action
   │  fs/promises only — no shell, no eval, no exec
   ▼
📂 Result
      Files and folders created. Progress reported back to phone.
```

### Layers

| Layer | Responsibility |
|---|---|
| **Phone** | Intent, context, approval, monitoring |
| **KRIYA Server** | WebSocket hub, NLP parsing, workflow planning, validation |
| **Local AI Planner** | Semantic understanding of the request, step generation |
| **Validation** | Schema checks, allowlist enforcement, path traversal rejection |
| **Human Approval** | Final gate before any execution |
| **Relay** | Message routing between phone and laptop (local or remote) |
| **Laptop Agent** | Executes approved, re-validated actions via `fs/promises` only |

---

## 🤖 Local AI

KRIYA V1.0 uses:

- **[Ollama](https://ollama.com/)** — a local model runtime
- **llama3.2:3b** — a compact instruction-tuned language model

**Why local AI?**

- Runs entirely on your machine — no cloud LLM account required
- Works with Apple Silicon / Metal GPU acceleration when available
- Provides natural-language semantic understanding for workflow planning
- Gracefully falls back to deterministic template-based planning if the model is unavailable, returns malformed output, or times out

> **Note:** llama3.2:3b is a small model. Its reasoning quality reflects that. KRIYA validates all LLM output against a strict schema and rejects anything that doesn't pass — so an imperfect model response always falls back to safe deterministic planning rather than failing silently.

---

## 🔐 Security by Design

KRIYA is built around the principle that **the AI is a planner, not an executor**.

| Principle | Implementation |
|---|---|
| LLM output is data, not code | LLM output is parsed into a validated JSON structure, never `eval`-ed |
| Workflow validation before execution | Schema, type, name, extension, and location checks run before the plan is shown to the user |
| Human approval required | No action executes without an explicit Approve tap |
| Allowlisted actions only | Only `CREATE_FOLDER`, `CREATE_WORKSPACE`, and `CREATE_TEXT_FILE` (.md / .txt) are permitted |
| No shell access | `exec`, `spawn`, `eval`, and `child_process` are not used in the laptop agent |
| Path traversal rejected | Both the server and laptop agent independently check that target paths stay within `~/Desktop` |
| File extension allowlist | Only `.md` and `.txt` are accepted for `CREATE_TEXT_FILE` |
| Relay does not execute | The relay server only routes WebSocket messages — it never accesses the filesystem |
| Outbound-only laptop connection | The laptop agent opens the connection to the relay; no inbound ports are exposed |
| One-time pairing tokens | Pairing tokens are 128-bit random values with a 5-minute TTL, consumed on first use |
| Session tokens | A 256-bit random session token authenticates all relay messages after pairing |
| Malformed relay messages rejected | Invalid session tokens and unknown message types return `RELAY_ERROR` |

---

## 📱 Phone-First Experience

The phone is the command center.

1. **Enter a request** — type a natural-language description of what you want to accomplish
2. **Use voice input** — tap the microphone and speak your request
3. **Use camera input** — photograph a document; KRIYA extracts the project context using OCR
4. **Review the workflow** — see every planned step before anything runs
5. **Approve or cancel** — nothing executes without your explicit approval
6. **Watch live progress** — each step is reported back to the phone as it runs
7. **Receive the result** — workspace appears on your laptop, confirmation shown on phone

---

## 🌍 Remote Laptop Access

### Local mode (same network)

```
📱 Phone browser
      │  WebSocket
      ▼
🖥️  KRIYA Server (localhost:3000)
      │  WebSocket
      ▼
💻 Laptop Agent (mac-agent.js)
```

Both devices must be on the same network. Run `node server/server.js` and `node server/mac-agent.js`.

### Remote mode (different network)

```
📱 Phone browser
      │  WebSocket (outbound)
      ▼
🔁 KRIYA Relay (relay.js — port 3100)
      ▲  WebSocket (outbound from laptop)
      │
💻 Laptop Agent (mac-agent.js --relay)
```

The **laptop agent opens the outbound connection** to the relay — the laptop never needs an inbound port or firewall rule. The relay only routes messages; it has no access to the laptop filesystem.

> **Production deployment note:** For real cross-internet use, the relay server must be hosted on a machine with a public IP and served over HTTPS/WSS (e.g. a VPS with a reverse proxy, or ngrok for testing). Running the relay on `localhost` only works for local testing.

**Quick remote test with ngrok:**
```bash
# Terminal 1 — start the relay
node server/relay.js

# Terminal 2 — expose relay publicly
npx ngrok http 3100

# Terminal 3 — start laptop agent pointing at relay
KRIYA_RELAY_URL=wss://<your-ngrok-id>.ngrok.io node server/mac-agent.js --relay
# Terminal shows QR code + pairing token

# Phone — open KRIYA, tap "Pair with Mac over Internet", paste token
```

---

## 🚀 Getting Started

### Requirements

- **Node.js** ≥ 18 (`node --version`)
- **npm** ≥ 9
- **[Ollama](https://ollama.com/)** installed and running
- **llama3.2:3b** model pulled
- A laptop capable of running the Node.js agent
- A modern phone browser (Chrome or Safari)

### Installation

```bash
git clone https://github.com/CSATYA16/kriya-ai.git
cd kriya-ai
npm install
```

### Pull the AI model

```bash
ollama pull llama3.2:3b
ollama serve   # keep this running in the background
```

---

## ▶️ Running KRIYA (Local Mode)

**Terminal 1 — KRIYA Server:**
```bash
npm run server
```
```
╔═══════════════════════════════════════════╗
║   ⚡ KRIYA Server                         ║
╚═══════════════════════════════════════════╝
  HTTP  → http://localhost:3000
  WS    → ws://localhost:3000
  📱 Open on phone: http://<YOUR_IP>:3000
```

**Terminal 2 — Laptop Agent:**
```bash
npm run agent
```
```
╔═══════════════════════════════════════════╗
║   ⚡ KRIYA Mac Agent v1.0                 ║
║   Mode: LOCAL (direct)                    ║
╚═══════════════════════════════════════════╝
  Allowlist: CREATE_FOLDER, CREATE_WORKSPACE, CREATE_TEXT_FILE
  [agent] Connected ✓
  [agent] Registered as MAC_AGENT ✓  Waiting for approved actions…
```

**Phone:**

Find your laptop's local IP (`ipconfig getifaddr en0`) and open:
```
http://<YOUR_LAPTOP_IP>:3000
```

---

## 🔁 Running KRIYA (Remote Mode)

**Terminal 1 — Relay:**
```bash
npm run relay
```

**Terminal 2 — Laptop Agent (relay mode):**
```bash
npm run agent:relay
# Shows QR code and pairing token in terminal
```

**Terminal 3 — Server (for workflow planning):**
```bash
npm run server
```

**Phone:**
1. Open KRIYA on your phone
2. Tap **"Pair with Mac over Internet"**
3. Enter the relay URL and paste the pairing token from the terminal
4. Tap **"Connect to Mac →"**
5. The phone shows **"● Mac · Connected"**

---

## 💬 Example Requests

```
Prepare my Hackathon project.
```
→ Creates `Hackathon/` with `Research/`, `Assets/`, `Documentation/`, `Presentation/`, `Tasks/`, `README.md`, `tasks.md`, `outline.md`

```
Set up my college project.
```
→ Creates `College_Project/` with subject folders and starter files

```
Create a workspace called Kriya for my AI project.
Inside it, prepare folders for research, assets, documentation and tasks.
```
→ Local AI parses the full intent: project name, context, requested folders

---

## 🗂️ Project Structure

```
kriya-ai/
├── index.html              # Phone web app (single-page, no framework)
├── package.json
├── README.md
└── server/
    ├── server.js           # KRIYA server — HTTP + WebSocket + workflow planner
    ├── mac-agent.js        # Laptop agent — local mode + relay mode
    ├── relay.js            # KRIYA Relay — WebSocket message router
    ├── pairing.js          # Pairing token + session management
    ├── llm-provider.js     # Ollama integration + validation + fallback
    └── test-integration.js # Integration test suite (227 tests)
```

---

## 🧪 Running Tests

```bash
npm test
```

Expected output:
```
Results: 227 passed, 0 failed
✅ All tests passed!
```

The test suite covers:

- NLP intent parsing
- Workflow planning (AI + deterministic fallback)
- Workflow validation
- Security rejection (path traversal, shell commands, unknown types, bad extensions)
- Multi-step E2E workflow execution (simulated)
- CREATE_TEXT_FILE security pipeline
- Malicious LLM output rejection
- Pairing token generation and one-time-use enforcement
- Session management (create, validate, remove, cleanup, concurrent)
- Relay WebSocket — registration, pairing, message routing, disconnect notification
- Relay security (bad token, unauthorized roles, missing session, null payload)
- Relay state persistence (screen navigation, reconnect, concurrent sessions)
- Malicious relay payload rejection at both server and agent layers

---

## 🛣️ Version History

| Version | Highlights |
|---|---|
| V0.4 | Voice input, Camera/OCR, CREATE_WORKSPACE, Phone-first UI |
| V0.6 | Workflow plan preview, approval flow, multi-step execution |
| V0.7 | KRIYA branding, premium UI, pause/cancel/retry, ACTION_PROGRESS |
| V0.8 | Ollama + llama3.2:3b local AI, semantic planning, deterministic fallback, 107 tests |
| V0.9 | CREATE_TEXT_FILE, workspace file creation, content-never-executed guard, 172 tests |
| **V1.0** | **Remote Mac Access — relay architecture, QR pairing, session auth, 227 tests** |

---

## 🤝 Contributing

Contributions are welcome. Please open an issue or pull request.

When contributing:
- Run `npm test` before submitting — all 227 tests must pass
- Do not remove the deterministic fallback planner
- Do not allow the LLM to execute actions directly
- Human approval must remain in the execution path
- All new actions must be added to the allowlist explicitly

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

*KRIYA — From Intent to Action.*
