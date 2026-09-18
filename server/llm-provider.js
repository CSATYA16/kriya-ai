'use strict';
/**
 * KRIYA V0.9 — LLM Provider Abstraction Layer
 *
 * V0.9 additions:
 *   - CREATE_TEXT_FILE action (.md / .txt only, WORKSPACE only)
 *   - MAX_STEPS raised to 20 (folders + file steps)
 *   - MAX_FILE_NAME_LENGTH, MAX_CONTENT_LENGTH constants
 *   - validateLLMOutput() updated for CREATE_TEXT_FILE
 *   - normalisePlan() preserves content field
 *   - SYSTEM_PROMPT extended with file schema + hackathon example
 *
 * Architecture (unchanged):
 *   AIPlannerWithFallback
 *     ├── LocalLLMProvider   (Ollama + llama3.2:3b)
 *     └── DeterministicProvider  (V0.7/V0.9 planWorkflow — always available)
 *
 * The LLM ONLY PLANS. Content is DATA — never executed.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_STEPS            = 20;   // raised from 10 to accommodate file steps
const MAX_FILE_NAME_LENGTH = 100;
const MAX_CONTENT_LENGTH   = 10_000;
const LLM_TIMEOUT_MS       = 15_000;
const OLLAMA_HOST          = process.env.OLLAMA_HOST      || 'http://127.0.0.1:11434';
const LLM_MODEL            = process.env.KRIYA_LLM_MODEL  || 'llama3.2:3b';

// ─── Allowlists ───────────────────────────────────────────────────────────────

const ALLOWED_TYPES      = new Set(['CREATE_FOLDER', 'CREATE_WORKSPACE', 'CREATE_TEXT_FILE']);
const ALLOWED_LOCATIONS  = new Set(['DESKTOP', 'WORKSPACE']);
const SAFE_NAME_RE       = /^[a-zA-Z0-9_\-. ]{1,64}$/;
const SAFE_FILE_NAME_RE  = /^[a-zA-Z0-9_\-. ]{1,100}$/;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const FORBIDDEN_KEYS     = new Set(['command', 'script', 'exec', 'shell', 'eval', 'code', 'bash', 'zsh', 'cmd']);

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are KRIYA's workflow planner. Your only job is to convert the user's productivity goal into a structured JSON workflow plan that creates a workspace with folders and useful starter files.

STRICT RULES:
1. You CANNOT execute commands, scripts, or code of any kind.
2. You CANNOT access the filesystem, network, or any Mac resource.
3. You CANNOT return shell commands, AppleScript, bash, Python, or any executable.
4. You MUST return ONLY valid JSON — no prose, no markdown wrapper, no explanation.
5. Allowed action types: "CREATE_FOLDER" and "CREATE_TEXT_FILE"
6. Locations: "DESKTOP" (first step only — creates root workspace folder) or "WORKSPACE" (all other steps)
7. The FIRST step MUST be CREATE_FOLDER with location "DESKTOP" — the root workspace.
8. ALL subsequent steps use location "WORKSPACE".
9. Folder names: letters, numbers, spaces, hyphens, underscores, dots only. Max 64 chars.
10. File names: only .md or .txt extensions allowed. Max 100 chars. No slashes, no .., no ~.
11. File content: plain text / Markdown only. Max 500 characters per file. No code, no scripts.
12. File location MUST be WORKSPACE — never DESKTOP.
13. Maximum 20 steps total.
14. Never invent a project name the user did not provide.
15. Do not put executable code, shell commands, or scripts in file content.

SCHEMA:
CREATE_FOLDER step: {"id":"step-N","type":"CREATE_FOLDER","name":"<folder name>","location":"DESKTOP|WORKSPACE"}
CREATE_TEXT_FILE step: {"id":"step-N","type":"CREATE_TEXT_FILE","name":"<filename.md>","location":"WORKSPACE","content":"<plain text / markdown>"}

Full workflow structure:
{"type":"WORKFLOW","name":"<project name>","goal":"<brief goal>","steps":[...steps...]}

If project name is unclear: {"type":"CLARIFICATION_REQUIRED","message":"What would you like to call the project?"}
If request is unsupported (delete files, run commands, install software): {"type":"UNSUPPORTED","message":"I can only create folders and text files."}

EXAMPLE — Hackathon project:
User: "Prepare my hackathon project."
Response: {"type":"WORKFLOW","name":"Hackathon","goal":"Prepare hackathon project workspace","steps":[{"id":"step-1","type":"CREATE_FOLDER","name":"Hackathon","location":"DESKTOP"},{"id":"step-2","type":"CREATE_FOLDER","name":"Research","location":"WORKSPACE"},{"id":"step-3","type":"CREATE_FOLDER","name":"Assets","location":"WORKSPACE"},{"id":"step-4","type":"CREATE_FOLDER","name":"Documentation","location":"WORKSPACE"},{"id":"step-5","type":"CREATE_FOLDER","name":"Presentation","location":"WORKSPACE"},{"id":"step-6","type":"CREATE_FOLDER","name":"Tasks","location":"WORKSPACE"},{"id":"step-7","type":"CREATE_TEXT_FILE","name":"README.md","location":"WORKSPACE","content":"# Hackathon\\n\\nProject workspace.\\n\\n## Structure\\n- Research\\n- Assets\\n- Documentation\\n- Presentation\\n- Tasks"},{"id":"step-8","type":"CREATE_TEXT_FILE","name":"tasks.md","location":"WORKSPACE","content":"# Tasks\\n\\n- Define problem statement\\n- Validate target users\\n- Build core prototype\\n- Test critical workflow\\n- Prepare final presentation"}]}

EXAMPLE — Video project:
User: "Prepare my video editing project called Monsoon Stories."
Response: {"type":"WORKFLOW","name":"Monsoon Stories","goal":"Prepare video editing workspace","steps":[{"id":"step-1","type":"CREATE_FOLDER","name":"Monsoon Stories","location":"DESKTOP"},{"id":"step-2","type":"CREATE_FOLDER","name":"Footage","location":"WORKSPACE"},{"id":"step-3","type":"CREATE_FOLDER","name":"Audio","location":"WORKSPACE"},{"id":"step-4","type":"CREATE_FOLDER","name":"Graphics","location":"WORKSPACE"},{"id":"step-5","type":"CREATE_FOLDER","name":"Exports","location":"WORKSPACE"},{"id":"step-6","type":"CREATE_TEXT_FILE","name":"README.md","location":"WORKSPACE","content":"# Monsoon Stories\\n\\nVideo editing workspace.\\n\\n## Structure\\n- Footage: raw video clips\\n- Audio: music and sound effects\\n- Graphics: motion graphics and overlays\\n- Exports: final renders"}]}

Now process the following user request. Return ONLY JSON, nothing else.`;

// ─── File name validator ──────────────────────────────────────────────────────

function validateFileName(name) {
  if (!name || typeof name !== 'string') return { ok: false, reason: 'File name missing.' };
  if (name.length > MAX_FILE_NAME_LENGTH) return { ok: false, reason: `File name too long (max ${MAX_FILE_NAME_LENGTH}).` };
  if (!SAFE_FILE_NAME_RE.test(name)) return { ok: false, reason: `File name "${name}" contains invalid characters.` };
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('~'))
    return { ok: false, reason: `File name "${name}" contains path traversal characters.` };
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) return { ok: false, reason: `File extension "${ext}" is not allowed. Only .md or .txt.` };
  return { ok: true };
}

// ─── Schema validator ─────────────────────────────────────────────────────────

function validateLLMOutput(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    return { ok: false, reason: 'LLM output is not a JSON object.' };

  if (plan.type === 'CLARIFICATION_REQUIRED' || plan.type === 'UNSUPPORTED' || plan.type === 'PARSE_ERROR') {
    if (typeof plan.message !== 'string' || !plan.message.trim())
      return { ok: false, reason: `${plan.type} response missing message.` };
    return { ok: true, passThrough: true };
  }

  if (plan.type !== 'WORKFLOW')
    return { ok: false, reason: `Unknown plan type: "${plan.type}"` };

  for (const key of Object.keys(plan))
    if (FORBIDDEN_KEYS.has(key.toLowerCase()))
      return { ok: false, reason: `Forbidden key in LLM output: "${key}"` };

  if (!plan.name || typeof plan.name !== 'string')
    return { ok: false, reason: 'Workflow name is missing.' };
  if (!SAFE_NAME_RE.test(plan.name.trim()))
    return { ok: false, reason: `Workflow name "${plan.name}" contains invalid characters.` };

  if (!Array.isArray(plan.steps) || plan.steps.length === 0)
    return { ok: false, reason: 'Workflow steps are missing or empty.' };
  if (plan.steps.length > MAX_STEPS)
    return { ok: false, reason: `Too many steps: ${plan.steps.length} (max ${MAX_STEPS}).` };

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step || typeof step !== 'object')
      return { ok: false, reason: `Step ${i+1} is not an object.` };

    for (const key of Object.keys(step))
      if (FORBIDDEN_KEYS.has(key.toLowerCase()))
        return { ok: false, reason: `Forbidden key in step ${i+1}: "${key}"` };

    if (!step.id || !/^step-\d+$/.test(String(step.id)))
      return { ok: false, reason: `Step ${i+1} has invalid id: "${step.id}"` };

    if (!ALLOWED_TYPES.has(step.type))
      return { ok: false, reason: `Step ${i+1}: type "${step.type}" is not allowed.` };

    if (!ALLOWED_LOCATIONS.has(step.location))
      return { ok: false, reason: `Step ${i+1}: location "${step.location}" is not allowed.` };

    if (i === 0 && step.location !== 'DESKTOP')
      return { ok: false, reason: 'First step must have location "DESKTOP".' };

    // ── Validate CREATE_FOLDER ──
    if (step.type === 'CREATE_FOLDER' || step.type === 'CREATE_WORKSPACE') {
      if (!step.name || typeof step.name !== 'string')
        return { ok: false, reason: `Step ${i+1} missing name.` };
      const sn = step.name.trim();
      if (!SAFE_NAME_RE.test(sn))
        return { ok: false, reason: `Step ${i+1} name "${sn}" invalid.` };
      if (sn.includes('..') || sn.includes('/') || sn.includes('\\') || sn.includes('~'))
        return { ok: false, reason: `Step ${i+1} name "${sn}" contains path traversal characters.` };
    }

    // ── Validate CREATE_TEXT_FILE ──
    if (step.type === 'CREATE_TEXT_FILE') {
      // Files must be in WORKSPACE
      if (step.location !== 'WORKSPACE')
        return { ok: false, reason: `Step ${i+1}: CREATE_TEXT_FILE must have location "WORKSPACE".` };

      const fnResult = validateFileName(step.name);
      if (!fnResult.ok) return { ok: false, reason: `Step ${i+1}: ${fnResult.reason}` };

      // content is required
      if (typeof step.content !== 'string')
        return { ok: false, reason: `Step ${i+1}: CREATE_TEXT_FILE content must be a string.` };
      if (step.content.length > MAX_CONTENT_LENGTH)
        return { ok: false, reason: `Step ${i+1}: content too long (${step.content.length} chars, max ${MAX_CONTENT_LENGTH}).` };
      if (step.content.includes('\0'))
        return { ok: false, reason: `Step ${i+1}: content contains null bytes.` };
    }
  }

  return { ok: true, passThrough: false };
}

// ─── Normalise plan ───────────────────────────────────────────────────────────

function normalisePlan(plan) {
  if (plan.type !== 'WORKFLOW') return plan;
  return {
    type: 'WORKFLOW',
    name: plan.name.trim(),
    goal: (plan.goal || '').trim() || plan.name.trim(),
    steps: plan.steps.map((s, i) => {
      const base = {
        id: `step-${i+1}`,
        type: s.type,
        name: s.name.trim(),
        location: s.location,
      };
      // Preserve content for CREATE_TEXT_FILE
      if (s.type === 'CREATE_TEXT_FILE') {
        base.content = typeof s.content === 'string' ? s.content : '';
      }
      return base;
    }),
  };
}

// ─── Base provider ────────────────────────────────────────────────────────────

class LLMProvider {
  async generateStructuredPlan(text) { throw new Error('Not implemented.'); } // eslint-disable-line no-unused-vars
  get name() { return 'LLMProvider'; }
  async isAvailable() { return false; }
}

// ─── LocalLLMProvider (Ollama) ────────────────────────────────────────────────

class LocalLLMProvider extends LLMProvider {
  constructor({ host = OLLAMA_HOST, model = LLM_MODEL, timeoutMs = LLM_TIMEOUT_MS } = {}) {
    super();
    this.host      = host;
    this.model     = model;
    this.timeoutMs = timeoutMs;
  }

  get name() { return `LocalLLM(${this.model})`; }

  async isAvailable() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.host}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch { return false; }
  }

  async generateStructuredPlan(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model:  this.model,
          stream: false,
          options: { temperature: 0.1, num_predict: 1024 },  // raised for file content
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: text },
          ],
        }),
      });
      clearTimeout(timer);

      if (!res.ok)
        throw new Error(`Ollama HTTP ${res.status}`);

      const data    = await res.json();
      const raw     = (data?.message?.content || '').trim();
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

      let parsed;
      try { parsed = JSON.parse(jsonStr); }
      catch { throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`); }

      const v = validateLLMOutput(parsed);
      if (!v.ok) throw new Error(`LLM output failed validation: ${v.reason}`);

      const plan = v.passThrough ? parsed : normalisePlan(parsed);
      return { plan, mode: 'AI' };

    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

// ─── DeterministicProvider (V0.9 planWorkflow) ───────────────────────────────

class DeterministicProvider extends LLMProvider {
  constructor(planWorkflowFn) {
    super();
    this._planWorkflow = planWorkflowFn;
  }
  get name() { return 'Deterministic'; }
  async isAvailable() { return true; }
  async generateStructuredPlan(text) {
    const plan = this._planWorkflow(text);
    return { plan, mode: 'FALLBACK' };
  }
}

// ─── MockLLMProvider (for tests) ─────────────────────────────────────────────

class MockLLMProvider extends LLMProvider {
  constructor(responses) {
    super();
    this._responses = responses;
  }
  get name() { return 'Mock'; }
  async isAvailable() { return true; }

  async generateStructuredPlan(text) {
    let result;
    if (typeof this._responses === 'function') {
      result = this._responses(text);
    } else {
      const key = Object.keys(this._responses).find(k => text.toLowerCase().includes(k.toLowerCase()));
      result = key ? this._responses[key] : { type: 'CLARIFICATION_REQUIRED', message: 'Mock: no match for input.' };
    }
    if (result instanceof Error) throw result;
    const v = validateLLMOutput(result);
    if (!v.ok) throw new Error(`MockLLMProvider: invalid preset — ${v.reason}`);
    const plan = v.passThrough ? result : normalisePlan(result);
    return { plan, mode: 'MOCK' };
  }
}

// ─── AIPlannerWithFallback ────────────────────────────────────────────────────

class AIPlannerWithFallback {
  constructor(primary, fallback) {
    this.primary  = primary;
    this.fallback = fallback;
  }

  async plan(text) {
    try {
      const result = await this.primary.generateStructuredPlan(text);
      console.log(`[llm] ${this.primary.name} -> mode=${result.mode}, type=${result.plan?.type}`);
      return result;
    } catch (err) {
      console.log(`[llm] ${this.primary.name} failed (${err.message.slice(0,120)}). Falling back.`);
      const result = await this.fallback.generateStructuredPlan(text);
      console.log(`[llm] ${this.fallback.name} -> mode=${result.mode}, type=${result.plan?.type}`);
      return result;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createProvider(planWorkflowFn, config = {}) {
  const deterministic = new DeterministicProvider(planWorkflowFn);

  if (config.mock !== undefined)
    return new AIPlannerWithFallback(new MockLLMProvider(config.mock), deterministic);

  if (config.disableAI)
    return new AIPlannerWithFallback(deterministic, deterministic);

  const local = new LocalLLMProvider({
    host:      config.host      || OLLAMA_HOST,
    model:     config.model     || LLM_MODEL,
    timeoutMs: config.timeoutMs || LLM_TIMEOUT_MS,
  });

  return new AIPlannerWithFallback(local, deterministic);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  LLMProvider,
  LocalLLMProvider,
  DeterministicProvider,
  MockLLMProvider,
  AIPlannerWithFallback,
  createProvider,
  validateLLMOutput,
  validateFileName,
  normalisePlan,
  MAX_STEPS,
  MAX_FILE_NAME_LENGTH,
  MAX_CONTENT_LENGTH,
  LLM_TIMEOUT_MS,
  LLM_MODEL,
  SYSTEM_PROMPT,
  ALLOWED_EXTENSIONS,
};
