'use strict';
/**
 * KRIYA Server v0.7
 * HTTP server (serves index.html) + WebSocket bridge between PHONE and MAC_AGENT.
 *
 * Clients identify themselves with { type: "REGISTER", role: "PHONE" | "MAC_AGENT" }
 * No shell execution happens here — only message routing and intent parsing.
 *
 * V0.7 additions:
 *   - planWorkflow(intent) → deterministic multi-step WORKFLOW plan
 *   - validateWorkflowPlan(plan) → allowlist each step
 *   - Sequential step-by-step execution with real ACTION_RESULT gating
 *   - WORKFLOW_PLAN, APPROVE_WORKFLOW, STEP_PROGRESS, WORKFLOW_COMPLETE,
 *     WORKFLOW_PAUSED, WORKFLOW_CANCELLED, CANCEL_WORKFLOW, RETRY_STEP
 *   - Backward-compat: single-action ACTION_READY / APPROVE still works
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// V0.8: LLM provider abstraction (Ollama + deterministic fallback)
const { createProvider, validateLLMOutput } = require('./llm-provider');

const PORT     = Number(process.env.PORT) || 3000;
const ROOT_DIR = path.join(__dirname, '..');

// ─── Connected clients ────────────────────────────────────────────────────────
let phoneClient = null;
let macAgent    = null;

/** In-flight single-action requests waiting for phone approval. requestId → action */
const pendingRequests = new Map();

/** In-flight workflow executions. workflowId → workflowState */
const activeWorkflows = new Map();

// V0.8: AI planner — created after planWorkflow() is defined (see bottom of startup section)
// aiPlanner is set below once planWorkflow is available.
let aiPlanner = null;

// ─── Intent parsing (V0.5.1 — preserved) ─────────────────────────────────────

function extractCommand(rawText) {
  let t = rawText.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const cmdMatch = t.match(/\b(create|make|set\s*up|setup|prepare|i\s+need|i\s+want)\b.{0,200}/i);
  if (cmdMatch) t = cmdMatch[0];
  return t;
}

function parseIntent(rawText) {
  if (!rawText || !rawText.trim()) return { type: 'PARSE_ERROR', message: 'Request is empty.' };

  const text  = extractCommand(rawText);
  const lower = text.toLowerCase();

  const forbiddenWords = ['delete', 'remove', 'rm ', 'run ', 'execute ', 'install', 'move', 'rename'];
  if (forbiddenWords.some(w => lower.includes(w))) {
    return { type: 'UNSUPPORTED', message: 'Action not supported. I can only create folders.' };
  }

  if (rawText.includes('..') || rawText.includes('~') || rawText.includes('\0')) {
    return { type: 'UNSUPPORTED', message: 'Invalid characters in request.' };
  }
  if (/[a-zA-Z0-9][\/\\]/.test(rawText) || /[\/\\][a-zA-Z0-9]/.test(rawText)) {
    return { type: 'UNSUPPORTED', message: 'Invalid characters in folder name.' };
  }

  const creationVerbs = ['create', 'make', 'setup', 'set up', 'add', 'prepare', 'need', 'want'];
  const folderNouns   = ['folder', 'directory', 'workspace'];
  const hasVerb = creationVerbs.some(v => lower.includes(v));
  const hasNoun = folderNouns.some(n  => lower.includes(n));

  if (hasVerb && !hasNoun) return { type: 'CLARIFICATION_REQUIRED', message: 'What would you like me to create on your Desktop?' };
  if (!hasVerb && !hasNoun) return { type: 'CLARIFICATION_REQUIRED', message: 'I am not sure what you want to do. Try asking me to create a folder.' };

  let rawName = null;

  const patExplicit = /\b(?:called|named|name\s+it(?:\s+as)?)\s+["']?([a-zA-Z0-9][a-zA-Z0-9_\-. ]*?)["']?\s*(?=\bon\b|\bin\b|\bat\b|\bto\b|\bfor\b|[.,!?;]|$)/i;
  const mExplicit = text.match(patExplicit);
  if (mExplicit && mExplicit[1]) rawName = mExplicit[1];

  if (!rawName) {
    const patForMy = /\bfor\s+(?:my|this|the)\s+([a-zA-Z0-9][a-zA-Z0-9 _\-]{0,50}?)\s+project\b/i;
    const mForMy = text.match(patForMy);
    if (mForMy && mForMy[1]) rawName = mForMy[1];
  }

  if (!rawName) {
    const patForProj = /\bfor\s+([a-zA-Z0-9][a-zA-Z0-9 _\-]{0,50}?)\s+project\b/i;
    const mForP = text.match(patForProj);
    if (mForP && mForP[1]) rawName = mForP[1];
  }

  if (!rawName) {
    const patDirect = /(?:create|make|setup|set\s+up|prepare)\s+(?:a\s+)?(?:new\s+)?(?:folder|directory|workspace)\s+(?:for\s+)?["']?([a-zA-Z0-9][a-zA-Z0-9 _\-]{0,50}?)["']?\s*(?=\bon\b|\bin\b|[.,!?;]|$)/i;
    const mDirect = text.match(patDirect);
    if (mDirect && mDirect[1]) rawName = mDirect[1];
  }

  if (!rawName) {
    const patFallback = /\b(?:folder|workspace|directory)\s+(?:for\s+)?["']?([A-Z][a-zA-Z0-9 _\-]{0,50}?)["']?\s*(?=\bon\b|\bin\b|[.,!?;]|$)/;
    const mFall = text.match(patFallback);
    if (mFall && mFall[1]) rawName = mFall[1];
  }

  if (!rawName) return { type: 'CLARIFICATION_REQUIRED', message: 'What should I name the folder?' };

  let cleanName = rawName.trim();
  cleanName = cleanName.replace(/^["']|["']$/g, '').trim();
  cleanName = cleanName.replace(/[.,!?;:]+$/, '').trim();
  cleanName = cleanName.replace(/\s+/g, ' ');
  cleanName = cleanName.replace(/\s+(?:on|in|at|to|the|my|a|an|desktop|folder|workspace|directory|project)$/i, '').trim();

  const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9_\-. ]{0,62}$/;
  if (!cleanName || !nameRe.test(cleanName)) {
    return { type: 'UNSUPPORTED', message: 'Folder name contains unsupported characters.' };
  }
  const reservedNames = ['desktop', 'my desktop', 'the desktop', 'folder', 'workspace', 'directory', 'project', 'a folder', 'a workspace'];
  if (reservedNames.includes(cleanName.toLowerCase())) {
    return { type: 'CLARIFICATION_REQUIRED', message: 'What should I name the folder?' };
  }

  const intentType = lower.includes('workspace') ? 'CREATE_WORKSPACE' : 'CREATE_FOLDER';
  return { type: intentType, name: cleanName, safeName: cleanName.replace(/\s+/g, '_'), location: 'DESKTOP' };
}

// ─── Action validation (allowlist) ───────────────────────────────────────────

const ALLOWED_TYPES      = ['CREATE_FOLDER', 'CREATE_WORKSPACE', 'CREATE_TEXT_FILE'];
const ALLOWED_LOCATIONS  = ['DESKTOP', 'WORKSPACE'];
const SAFE_NAME_RE       = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const SAFE_FILE_NAME_RE  = /^[a-zA-Z0-9_\-. ]{1,100}$/;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const MAX_FILE_NAME_LENGTH = 100;
const MAX_CONTENT_LENGTH   = 10_000;
const MAX_WORKFLOW_STEPS   = 20;

function validateAction(action) {
  if (!action || typeof action !== 'object')
    return { ok: false, reason: 'Invalid action object.' };
  if (!ALLOWED_TYPES.includes(action.type))
    return { ok: false, reason: `Action "${action.type}" is not allowed.` };

  if (action.type === 'CREATE_FOLDER' || action.type === 'CREATE_WORKSPACE') {
    if (!action.name || !SAFE_NAME_RE.test(action.name))
      return { ok: false, reason: `Name "${action.name}" contains invalid characters or is too long.` };
    if (!ALLOWED_LOCATIONS.includes(action.location))
      return { ok: false, reason: `Location "${action.location}" is not allowed. Only DESKTOP or WORKSPACE.` };
  }

  if (action.type === 'CREATE_TEXT_FILE') {
    // Files must be inside a workspace — never bare DESKTOP
    if (action.location !== 'WORKSPACE')
      return { ok: false, reason: 'CREATE_TEXT_FILE must use location "WORKSPACE".' };

    const name = action.name;
    if (!name || typeof name !== 'string')
      return { ok: false, reason: 'CREATE_TEXT_FILE missing name.' };
    if (name.length > MAX_FILE_NAME_LENGTH)
      return { ok: false, reason: `File name too long (max ${MAX_FILE_NAME_LENGTH} chars).` };
    if (!SAFE_FILE_NAME_RE.test(name))
      return { ok: false, reason: `File name "${name}" contains invalid characters.` };
    if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('~'))
      return { ok: false, reason: `File name "${name}" contains path traversal characters.` };

    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.has(ext))
      return { ok: false, reason: `File extension "${ext}" is not allowed. Only .md or .txt.` };

    if (typeof action.content !== 'string')
      return { ok: false, reason: 'CREATE_TEXT_FILE content must be a string.' };
    if (action.content.length > MAX_CONTENT_LENGTH)
      return { ok: false, reason: `File content too long (max ${MAX_CONTENT_LENGTH} chars).` };
    if (action.content.includes('\0'))
      return { ok: false, reason: 'File content contains null bytes.' };
  }

  return { ok: true };
}

// ─── V0.7: Workflow Planner ───────────────────────────────────────────────────

/**
 * planWorkflow(intent)
 *
 * Deterministic local planner. Returns a WORKFLOW object.
 * Designed so an LLM can replace this function later — same interface.
 *
 * Returns:
 *   { type:'WORKFLOW', name, goal, steps: [{id, type, name, location}] }
 *   or a parse-error intent for unknown/rejected requests.
 */
function planWorkflow(rawText) {
  if (!rawText || !rawText.trim()) return { type: 'PARSE_ERROR', message: 'Request is empty.' };

  const lower = rawText.toLowerCase();

  // ── Security: forbidden raw text ──────────────────────────────────────────
  const forbiddenWords = ['delete', 'remove', 'rm ', 'run ', 'execute ', 'install', 'move', 'rename'];
  if (forbiddenWords.some(w => lower.includes(w))) {
    return { type: 'UNSUPPORTED', message: 'Action not supported. I can only create folders and files.' };
  }
  if (rawText.includes('..') || rawText.includes('~') || rawText.includes('\0')) {
    return { type: 'UNSUPPORTED', message: 'Invalid characters in request.' };
  }
  if (/[a-zA-Z0-9][\/\\]/.test(rawText) || /[\/\\][a-zA-Z0-9]/.test(rawText)) {
    return { type: 'UNSUPPORTED', message: 'Invalid characters in request.' };
  }

  // ── Multi-step workflow patterns ──────────────────────────────────────────

  // A. Hackathon project
  if (/hackathon/i.test(lower) && (lower.includes('prepare') || lower.includes('set up') || lower.includes('setup') || lower.includes('my hackathon project') || lower.includes('my project'))) {
    return {
      type: 'WORKFLOW',
      name: 'Hackathon Project',
      goal: rawText.trim(),
      steps: [
        { id: 'step-1',  type: 'CREATE_FOLDER',    name: 'Hackathon',     location: 'DESKTOP'   },
        { id: 'step-2',  type: 'CREATE_FOLDER',    name: 'Research',      location: 'WORKSPACE' },
        { id: 'step-3',  type: 'CREATE_FOLDER',    name: 'Assets',        location: 'WORKSPACE' },
        { id: 'step-4',  type: 'CREATE_FOLDER',    name: 'Documentation', location: 'WORKSPACE' },
        { id: 'step-5',  type: 'CREATE_FOLDER',    name: 'Presentation',  location: 'WORKSPACE' },
        { id: 'step-6',  type: 'CREATE_FOLDER',    name: 'Tasks',         location: 'WORKSPACE' },
        { id: 'step-7',  type: 'CREATE_TEXT_FILE', name: 'README.md',     location: 'WORKSPACE',
          content: '# Hackathon Project\n\nProject workspace.\n\n## Structure\n- Research\n- Assets\n- Documentation\n- Presentation\n- Tasks' },
        { id: 'step-8',  type: 'CREATE_TEXT_FILE', name: 'tasks.md',      location: 'WORKSPACE',
          content: '# Hackathon Tasks\n\n- [ ] Define problem statement\n- [ ] Validate target users\n- [ ] Build core prototype\n- [ ] Test critical workflow\n- [ ] Prepare final presentation\n- [ ] Prepare live demo' },
        { id: 'step-9',  type: 'CREATE_TEXT_FILE', name: 'outline.md',    location: 'WORKSPACE',
          content: '# Presentation Outline\n\n## 1. Problem Statement\n## 2. Solution Overview\n## 3. Demo\n## 4. Impact\n## 5. Next Steps' },
      ],
    };
  }

  // B. College project
  if (/college\s+project/i.test(lower) && (lower.includes('set up') || lower.includes('setup') || lower.includes('prepare') || lower.includes('my college') || lower.includes('my project'))) {
    return {
      type: 'WORKFLOW',
      name: 'College Project',
      goal: rawText.trim(),
      steps: [
        { id: 'step-1', type: 'CREATE_FOLDER',    name: 'College_Project', location: 'DESKTOP'   },
        { id: 'step-2', type: 'CREATE_FOLDER',    name: 'Research',        location: 'WORKSPACE' },
        { id: 'step-3', type: 'CREATE_FOLDER',    name: 'Documentation',   location: 'WORKSPACE' },
        { id: 'step-4', type: 'CREATE_FOLDER',    name: 'Assets',          location: 'WORKSPACE' },
        { id: 'step-5', type: 'CREATE_FOLDER',    name: 'Tasks',           location: 'WORKSPACE' },
        { id: 'step-6', type: 'CREATE_TEXT_FILE', name: 'README.md',       location: 'WORKSPACE',
          content: '# College Project\n\nProject workspace.\n\n## Structure\n- Research\n- Documentation\n- Assets\n- Tasks' },
        { id: 'step-7', type: 'CREATE_TEXT_FILE', name: 'tasks.md',        location: 'WORKSPACE',
          content: '# Tasks\n\n- [ ] Define project scope\n- [ ] Literature review\n- [ ] Draft outline\n- [ ] Write report\n- [ ] Prepare presentation' },
      ],
    };
  }

  // C. Presentation workspace
  if (/presentation/i.test(lower) && (lower.includes('workspace') || lower.includes('prepare') || (lower.includes('set up') && lower.includes('presentation')))) {
    return {
      type: 'WORKFLOW',
      name: 'Presentation Workspace',
      goal: rawText.trim(),
      steps: [
        { id: 'step-1', type: 'CREATE_FOLDER',    name: 'Presentation_Workspace', location: 'DESKTOP'   },
        { id: 'step-2', type: 'CREATE_FOLDER',    name: 'Research',               location: 'WORKSPACE' },
        { id: 'step-3', type: 'CREATE_FOLDER',    name: 'Assets',                 location: 'WORKSPACE' },
        { id: 'step-4', type: 'CREATE_FOLDER',    name: 'Slides',                 location: 'WORKSPACE' },
        { id: 'step-5', type: 'CREATE_FOLDER',    name: 'Notes',                  location: 'WORKSPACE' },
        { id: 'step-6', type: 'CREATE_TEXT_FILE', name: 'outline.md',             location: 'WORKSPACE',
          content: '# Presentation Outline\n\n## Introduction\n## Key Points\n## Demo / Evidence\n## Conclusion\n## Q&A' },
        { id: 'step-7', type: 'CREATE_TEXT_FILE', name: 'notes.md',               location: 'WORKSPACE',
          content: '# Speaker Notes\n\nAdd your speaker notes here.' },
      ],
    };
  }

  // D. Research workspace
  if (/research\s+workspace/i.test(lower) || (/research/i.test(lower) && (lower.includes('prepare') || lower.includes('set up') || lower.includes('setup')))) {
    if (!/hackathon/i.test(lower)) {
      return {
        type: 'WORKFLOW',
        name: 'Research Workspace',
        goal: rawText.trim(),
        steps: [
          { id: 'step-1', type: 'CREATE_FOLDER',    name: 'Research_Workspace', location: 'DESKTOP'   },
          { id: 'step-2', type: 'CREATE_FOLDER',    name: 'Sources',            location: 'WORKSPACE' },
          { id: 'step-3', type: 'CREATE_FOLDER',    name: 'Notes',              location: 'WORKSPACE' },
          { id: 'step-4', type: 'CREATE_FOLDER',    name: 'References',         location: 'WORKSPACE' },
          { id: 'step-5', type: 'CREATE_FOLDER',    name: 'Documentation',      location: 'WORKSPACE' },
          { id: 'step-6', type: 'CREATE_TEXT_FILE', name: 'README.md',          location: 'WORKSPACE',
            content: '# Research Workspace\n\n## Structure\n- Sources: primary research materials\n- Notes: working notes\n- References: citations and bibliography\n- Documentation: final write-up' },
          { id: 'step-7', type: 'CREATE_TEXT_FILE', name: 'notes.md',           location: 'WORKSPACE',
            content: '# Research Notes\n\n## Topic\n\n## Key Findings\n\n## Open Questions' },
        ],
      };
    }
  }

  // ── Fallback: single-action via existing parseIntent ──────────────────────
  const singleAction = parseIntent(rawText);
  if (singleAction.type === 'CREATE_FOLDER' || singleAction.type === 'CREATE_WORKSPACE') {
    return {
      type: 'WORKFLOW',
      name: singleAction.name,
      goal: rawText.trim(),
      steps: [
        { id: 'step-1', type: singleAction.type, name: singleAction.name, location: 'DESKTOP' },
      ],
    };
  }

  // Pass through errors
  return singleAction;
}

/**
 * validateWorkflowPlan(plan)
 * Validates each step in a workflow plan.
 * Returns { ok: true } or { ok: false, reason, stepId }.
 */
function validateWorkflowPlan(plan) {
  if (!plan || plan.type !== 'WORKFLOW') return { ok: false, reason: 'Not a workflow plan.' };
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { ok: false, reason: 'Workflow has no steps.' };
  if (plan.steps.length > MAX_WORKFLOW_STEPS) return { ok: false, reason: `Too many steps: ${plan.steps.length} (max ${MAX_WORKFLOW_STEPS}).` };

  for (const step of plan.steps) {
    const v = validateAction(step);
    if (!v.ok) return { ok: false, reason: v.reason, stepId: step.id };
  }
  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastMacStatus() {
  const mac_connected = macAgent !== null && macAgent.readyState === WebSocket.OPEN;
  send(phoneClient, { type: 'STATUS_UPDATE', mac_connected });
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── V0.7: Sequential workflow executor ──────────────────────────────────────

/**
 * Execute a workflow step by step.
 * State is tracked in activeWorkflows map.
 * Each step waits for real ACTION_RESULT before dispatching the next.
 */
async function executeWorkflow(workflowId, plan) {
  const state = {
    workflowId,
    plan,
    currentStepIndex: 0,
    cancelled: false,
    workspaceRoot: null,        // set after step-1 succeeds (DESKTOP folder)
    completedSteps: [],
    failedStep: null,
  };
  activeWorkflows.set(workflowId, state);

  await runNextStep(workflowId);
}

function runNextStep(workflowId) {
  const state = activeWorkflows.get(workflowId);
  if (!state) return;
  if (state.cancelled) return;

  const { plan, currentStepIndex } = state;
  if (currentStepIndex >= plan.steps.length) {
    // All steps done
    activeWorkflows.delete(workflowId);
    send(phoneClient, {
      type: 'WORKFLOW_COMPLETE',
      workflowId,
      name: plan.name,
      completedSteps: state.completedSteps,
    });
    console.log(`[server] Workflow [${workflowId}] complete. ${state.completedSteps.length} steps.`);
    return;
  }

  const step = plan.steps[currentStepIndex];

  if (!macAgent || macAgent.readyState !== WebSocket.OPEN) {
    send(phoneClient, { type: 'ERROR', message: 'Mac agent disconnected during workflow.' });
    activeWorkflows.delete(workflowId);
    return;
  }

  // Notify phone which step is running
  send(phoneClient, {
    type: 'STEP_RUNNING',
    workflowId,
    stepId: step.id,
    stepIndex: currentStepIndex,
    total: plan.steps.length,
    name: step.name,
  });

  // Resolve WORKSPACE location if needed
  let resolvedStep = { ...step };
  if (step.location === 'WORKSPACE') {
    if (!state.workspaceRoot) {
      // Can't proceed without workspace root
      send(phoneClient, {
        type: 'WORKFLOW_PAUSED',
        workflowId,
        failedStepId: step.id,
        failedStepIndex: currentStepIndex,
        failedStepName: step.name,
        message: 'Cannot create sub-folder: workspace root was not established.',
        completedSteps: state.completedSteps,
      });
      activeWorkflows.delete(workflowId);
      return;
    }
    resolvedStep = { ...step, workspaceRoot: state.workspaceRoot };
  }

  const requestId = makeId();
  // Tag this requestId as part of a workflow
  pendingRequests.set(requestId, { ...resolvedStep, _workflowId: workflowId, _stepIndex: currentStepIndex });

  console.log(`[server] Workflow [${workflowId}] step ${currentStepIndex + 1}/${plan.steps.length}: ${step.type} "${step.name}"`);
  send(macAgent, { type: 'EXECUTE_ACTION', requestId, action: resolvedStep });
}

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT_DIR, urlPath);

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  let role = null;
  const ip = req.socket.remoteAddress;
  console.log(`[server] WS connection from ${ip}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── Registration ─────────────────────────────────────────────────────
      case 'REGISTER': {
        role = msg.role;
        if (role === 'PHONE') {
          if (phoneClient && phoneClient !== ws && phoneClient.readyState === WebSocket.OPEN) {
            phoneClient.close(1001, 'Replaced by new phone connection');
          }
          phoneClient = ws;
          const mac_connected = macAgent !== null && macAgent.readyState === WebSocket.OPEN;
          send(ws, { type: 'REGISTERED', role, mac_connected });
          console.log('[server] Phone registered. Mac connected:', mac_connected);
        } else if (role === 'MAC_AGENT') {
          if (macAgent && macAgent !== ws && macAgent.readyState === WebSocket.OPEN) {
            macAgent.close(1001, 'Replaced by new agent connection');
          }
          macAgent = ws;
          send(ws, { type: 'REGISTERED', role });
          broadcastMacStatus();
          console.log('[server] Mac agent registered');
        }
        break;
      }

      // ── Phone → parse intent + plan workflow ──────────────────────────────
      case 'WORKFLOW_REQUEST': {
        if (role !== 'PHONE') break;
        const text = String(msg.text || '').trim();
        console.log(`[server] Workflow request: "${text}"`);

        if (!macAgent || macAgent.readyState !== WebSocket.OPEN) {
          send(phoneClient, { type: 'ERROR', message: 'Mac agent is not connected. Run: npm run agent' });
          break;
        }

        // V0.8: async AI planning with deterministic fallback
        (async () => {
          let plan, plannerMode;
          try {
            const result = await aiPlanner.plan(text);
            plan        = result.plan;
            plannerMode = result.mode;
          } catch (err) {
            console.error('[server] aiPlanner.plan threw unexpectedly:', err.message);
            plan        = { type: 'PARSE_ERROR', message: 'Planning failed. Please try again.' };
            plannerMode = 'FALLBACK';
          }

          if (plan.type === 'UNSUPPORTED' || plan.type === 'CLARIFICATION_REQUIRED' || plan.type === 'PARSE_ERROR') {
            send(phoneClient, { type: plan.type, message: plan.message, plannerMode });
            return;
          }

          const v = validateWorkflowPlan(plan);
          if (!v.ok) {
            send(phoneClient, { type: 'PARSE_ERROR', message: v.reason, plannerMode });
            return;
          }

          // Single-action backward compat: still send ACTION_READY for 1-step DESKTOP-only flows
          if (plan.steps.length === 1 && plan.steps[0].location === 'DESKTOP') {
            const action    = plan.steps[0];
            const requestId = makeId();
            pendingRequests.set(requestId, action);
            send(phoneClient, { type: 'ACTION_READY', requestId, action, plannerMode });
            console.log(`[server] Single-action ready [${requestId}]:`, action);
            return;
          }

          // Multi-step: send workflow plan for approval
          const workflowId = makeId();
          pendingRequests.set(workflowId, { _isPlan: true, plan });
          send(phoneClient, { type: 'WORKFLOW_PLAN', workflowId, name: plan.name, goal: plan.goal, steps: plan.steps, plannerMode });
          console.log(`[server] Workflow plan [${workflowId}]: "${plan.name}" — ${plan.steps.length} steps (${plannerMode})`);
        })();
        break;
      }

      // ── Phone → approve single action (legacy / 1-step) ──────────────────
      case 'APPROVE': {
        if (role !== 'PHONE') break;
        const { requestId } = msg;
        const action = pendingRequests.get(requestId);
        if (!action) {
          send(phoneClient, { type: 'ERROR', message: 'Request not found or already processed.' });
          break;
        }
        if (action._isPlan) {
          // Someone sent APPROVE for a workflow ID — treat as APPROVE_WORKFLOW
          handleApproveWorkflow(action.plan, requestId);
          pendingRequests.delete(requestId);
          break;
        }
        if (!macAgent || macAgent.readyState !== WebSocket.OPEN) {
          send(phoneClient, { type: 'ERROR', message: 'Mac agent disconnected before execution.' });
          break;
        }
        console.log(`[server] Approved [${requestId}]. Forwarding to Mac agent.`);
        send(phoneClient, { type: 'EXECUTING', requestId });
        send(macAgent, { type: 'EXECUTE_ACTION', requestId, action });
        break;
      }

      // ── Phone → approve workflow ──────────────────────────────────────────
      case 'APPROVE_WORKFLOW': {
        if (role !== 'PHONE') break;
        const { workflowId } = msg;
        const entry = pendingRequests.get(workflowId);
        if (!entry || !entry._isPlan) {
          send(phoneClient, { type: 'ERROR', message: 'Workflow not found or already processed.' });
          break;
        }
        if (!macAgent || macAgent.readyState !== WebSocket.OPEN) {
          send(phoneClient, { type: 'ERROR', message: 'Mac agent disconnected before execution.' });
          break;
        }
        pendingRequests.delete(workflowId);
        handleApproveWorkflow(entry.plan, workflowId);
        break;
      }

      // ── Phone → cancel single action ──────────────────────────────────────
      case 'CANCEL': {
        if (role !== 'PHONE') break;
        const { requestId } = msg;
        pendingRequests.delete(requestId);
        send(phoneClient, { type: 'CANCELLED', requestId });
        console.log(`[server] Cancelled [${requestId}]`);
        break;
      }

      // ── Phone → cancel workflow ───────────────────────────────────────────
      case 'CANCEL_WORKFLOW': {
        if (role !== 'PHONE') break;
        const { workflowId } = msg;

        // May be pending approval or actively executing
        if (pendingRequests.has(workflowId)) {
          pendingRequests.delete(workflowId);
        }

        const state = activeWorkflows.get(workflowId);
        if (state) {
          state.cancelled = true;
          activeWorkflows.delete(workflowId);
        }

        send(phoneClient, {
          type: 'WORKFLOW_CANCELLED',
          workflowId,
          message: 'Workflow cancelled. Completed actions were not undone.',
          completedSteps: state ? state.completedSteps : [],
        });
        console.log(`[server] Workflow cancelled [${workflowId}]`);
        break;
      }

      // ── Phone → retry failed step ─────────────────────────────────────────
      case 'RETRY_STEP': {
        if (role !== 'PHONE') break;
        const { workflowId } = msg;
        const state = activeWorkflows.get(workflowId);
        if (!state) {
          send(phoneClient, { type: 'ERROR', message: 'Workflow not found for retry.' });
          break;
        }
        if (!macAgent || macAgent.readyState !== WebSocket.OPEN) {
          send(phoneClient, { type: 'ERROR', message: 'Mac agent not connected.' });
          break;
        }
        state.failedStep = null;
        console.log(`[server] Retrying workflow [${workflowId}] at step ${state.currentStepIndex + 1}`);
        runNextStep(workflowId);
        break;
      }

      // ── Mac agent → progress ──────────────────────────────────────────────
      case 'ACTION_PROGRESS': {
        if (role !== 'MAC_AGENT') break;
        send(phoneClient, { type: 'PROGRESS', ...msg });
        break;
      }

      // ── Mac agent → result ────────────────────────────────────────────────
      case 'ACTION_RESULT': {
        if (role !== 'MAC_AGENT') break;
        const { requestId, success, message, path: resultPath, createdFolders } = msg;
        const stepAction = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);

        console.log(`[server] Action result [${requestId}]: success=${success} — ${message}`);

        // Check if this belongs to a workflow
        if (stepAction && stepAction._workflowId) {
          const workflowId = stepAction._workflowId;
          const state = activeWorkflows.get(workflowId);
          if (!state || state.cancelled) break;

          if (success) {
            // Record workspace root from step-1 (DESKTOP folder)
            if (stepAction._stepIndex === 0 && stepAction.location === 'DESKTOP' && resultPath) {
              state.workspaceRoot = resultPath;
              console.log(`[server] Workspace root set: ${resultPath}`);
            }
            state.completedSteps.push({ id: stepAction.id, name: stepAction.name });
            state.currentStepIndex++;

            send(phoneClient, {
              type: 'STEP_PROGRESS',
              workflowId,
              stepId: stepAction.id,
              stepIndex: stepAction._stepIndex,
              total: state.plan.steps.length,
              name: stepAction.name,
              success: true,
              completedCount: state.completedSteps.length,
            });

            // Continue with next step
            runNextStep(workflowId);
          } else {
            // Step failed — pause workflow
            state.failedStep = { id: stepAction.id, index: stepAction._stepIndex, name: stepAction.name };
            send(phoneClient, {
              type: 'WORKFLOW_PAUSED',
              workflowId,
              failedStepId: stepAction.id,
              failedStepIndex: stepAction._stepIndex,
              failedStepName: stepAction.name,
              message: message || 'Step failed.',
              completedSteps: state.completedSteps,
            });
            console.log(`[server] Workflow [${workflowId}] paused at step ${stepAction._stepIndex + 1}: ${message}`);
          }
        } else {
          // Single-action result — legacy path
          send(phoneClient, { type: 'RESULT', requestId, success, message, path: resultPath, createdFolders });
        }
        break;
      }

      default:
        console.log(`[server] Unknown message type "${msg.type}" from role "${role}"`);
    }
  });

  ws.on('close', (code, reason) => {
    if (role === 'PHONE' && phoneClient === ws) {
      phoneClient = null;
      console.log(`[server] Phone disconnected (${code})`);
    }
    if (role === 'MAC_AGENT' && macAgent === ws) {
      macAgent = null;
      console.log(`[server] Mac agent disconnected (${code})`);
      broadcastMacStatus();
    }
  });

  ws.on('error', (err) => {
    console.error(`[server] WS error (role=${role}): ${err.message}`);
  });
});

function handleApproveWorkflow(plan, workflowId) {
  console.log(`[server] Workflow approved [${workflowId}]: "${plan.name}" — ${plan.steps.length} steps`);
  send(phoneClient, { type: 'WORKFLOW_EXECUTING', workflowId, name: plan.name, steps: plan.steps });
  executeWorkflow(workflowId, plan);
}

// ─── Exports for testing ──────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { parseIntent, planWorkflow, validateWorkflowPlan, validateAction,
    ALLOWED_TYPES, ALLOWED_EXTENSIONS, MAX_FILE_NAME_LENGTH, MAX_CONTENT_LENGTH, MAX_WORKFLOW_STEPS };
}

// ─── V0.8: Initialise AI planner (after planWorkflow is in scope) ─────────────
// Tests can override this by setting process.env.KRIYA_DISABLE_AI=1
aiPlanner = require('./llm-provider').createProvider(planWorkflow, {
  disableAI: process.env.KRIYA_DISABLE_AI === '1',
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const aiMode = process.env.KRIYA_DISABLE_AI === '1' ? 'FALLBACK MODE' : 'LOCAL AI';
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   ⚡ KRIYA Server v0.9                ║');
  console.log(`║   ${aiMode.padEnd(35)}║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\n  HTTP  → http://localhost:${PORT}`);
  console.log(`  WS    → ws://localhost:${PORT}`);
  console.log(`\n  📱 Open on phone: http://<MAC_IP>:${PORT}`);
  console.log(`  🔍 Find your IP:  ipconfig getifaddr en0\n`);
});

