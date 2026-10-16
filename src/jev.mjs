#!/usr/bin/env node
// Jev 開關：開啟時，Claude Code 裡適合判斷／分類的步驟（Skill 篩選、任務類型、子代理模型、Shell 指令風險）
// 一律交給 TypeSafe Jev（System One）判斷；這些步驟不呼叫任何大模型。Jev 失效時警告並照原本方式運作。
//
// 用法：
//   hook：node jev.mjs hook <prompt|expansion|agent|risk>   （stdin 是 Claude Code 的 hook JSON）
//   指令：node jev.mjs cli <on|lite|off|status|test 文字|log [n]>
//   on   = 完整模式（Skill 篩選、任務類型、子代理模型、Shell 風險把關）
//   lite = 提示模式（只留 Skill 篩選與任務類型；不擋指令、不改子代理模型）
// 金鑰：環境變數 TYPESAFE_API_KEY 優先；沒有就讀金鑰檔 ~/.claude/jev/api_key（與 WSL 版相同；可用 TYPESAFE_API_KEY_FILE 改路徑）。測試用：JEV_MOCK_FILE 指向 {"<question id>": answer} 的 JSON，不打 API。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE = path.join(os.homedir(), '.claude');
const DIR = path.join(CLAUDE, 'jev');
const STATE = path.join(DIR, 'state.json');
const CONFIG = path.join(DIR, 'config.json');
const LOG = path.join(DIR, 'log.jsonl');
const WARNED = path.join(DIR, 'warned.json');
const API = 'https://api.typesafe.ai/v1/systemone';
const KEY_FILE = process.env.TYPESAFE_API_KEY_FILE || path.join(DIR, 'api_key');

// 回傳 { key, source }；都沒有時 key 為空字串。
function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY.trim(), source: '環境變數' };
  try {
    return { key: fs.readFileSync(KEY_FILE, 'utf8').trim(), source: `金鑰檔 ${KEY_FILE}` };
  } catch {
    return { key: '', source: '' };
  }
}

const DEFAULTS = {
  model: 'jev-latest',
  features: { skills: true, taskType: true, agentModel: true, shellRisk: true },
  // Skill suggestion cookbook 的門檻：gate、fits 低於門檻就不建議。
  skills: { gate: 0.3, fits: 0.3, shortlist: 3, excerptChars: 700, descriptionChars: 240, minPromptChars: 4 },
  taskType: { minConfidence: 0.6 },
  agentModel: { minConfidence: 0.6 },
  // Guardrails cookbook 的 strict action threshold。只會升級成「要確認」，不會放行。
  // askOn：哪幾項風險會觸發確認。outward（影響本機以外）測 API、部署幾乎每次都成立，只記錄不觸發（2026-10-13）。
  // exempt：符合就不送 Jev（dev 環境 API、測試身分、scratchpad 腳本）；但符合 neverExempt 的指令一律照送。
  shellRisk: {
    ask: 0.9,
    askOn: ['destructive', 'secrets'],
    exempt: [
      'AppData[\\\\/]Local[\\\\/]Temp[\\\\/]claude[\\\\/]',
    ],
    neverExempt: [
      '\\brm\\s+-[a-zA-Z]*[rf]',
      'Remove-Item',
      'git\\s+push',
      '--force',
      'reset\\s+--hard',
      'wrangler\\s+(deploy|secret|delete)',
      '--env\\s+production',
      'DROP\\s+TABLE',
      'DELETE\\s+FROM',
    ],
  },
  timeoutMs: { prompt: 12000, tool: 6000 },
};

// ---------- 共用 ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const config = () => merge(DEFAULTS, readJson(CONFIG, {}));
const enabled = () => readJson(STATE, { enabled: false }).enabled === true;
// 模式：full（完整）或 lite（只留 Skill 篩選與任務類型）。舊狀態檔沒有 mode 視為 full。
const jevMode = () => (readJson(STATE, {}).mode === 'lite' ? 'lite' : 'full');
const MODE_LABEL = { full: '完整模式', lite: '提示模式（只留 Skill 建議與任務類型）' };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const pct = (x) => x.toFixed(2);

function log(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // 紀錄失敗不影響判斷
  }
}

class JevError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// 只打 TypeSafe System One API；沒有任何退回大模型的路徑。
async function jev(state, questions, timeoutMs, cfg) {
  if (process.env.JEV_MOCK_FILE) return mock(questions);
  const { key } = apiKey();
  if (!key) throw new JevError('no_key', `沒有設定 TYPESAFE_API_KEY，也找不到金鑰檔 ${KEY_FILE}`);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ state, model: cfg.model, questions }),
        signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
      });
    } catch (e) {
      throw new JevError('network', e?.name === 'TimeoutError' ? `逾時（${timeoutMs} ms）` : String(e?.message ?? e));
    }
    if (res.ok) return res.json();
    // 429／529 依文件建議退避重試，時間不夠就放棄。
    if ((res.status === 429 || res.status === 529) && attempt === 0 && deadline - Date.now() > 1500) {
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new JevError(res.status === 401 ? 'auth' : 'http', `HTTP ${res.status} ${clip(body, 160)}`);
  }
}

function mock(questions) {
  const answers = readJson(process.env.JEV_MOCK_FILE, {});
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    if (answers[id]) out[id] = answers[id];
    else if (q.type === 'noul') out[id] = { type: 'noul', noul: 0 };
    else {
      const keys = Object.keys(q.criteria);
      out[id] = { type: 'choice', choice: keys[0], confidence: 0, probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) };
    }
  }
  return { model: 'mock', answers: out, usage: { input_tokens: 0, output_tokens: 0 } };
}

// 同一個 session、同一種錯誤只警告一次，避免每個指令都跳警告。
function warnOnce(sessionId, err) {
  const seen = readJson(WARNED, {});
  const key = sessionId || 'unknown';
  const kinds = seen[key] || [];
  if (kinds.includes(err.kind)) return null;
  const sessions = Object.keys(seen).filter((k) => k !== key).slice(-19);
  writeJson(WARNED, { ...Object.fromEntries(sessions.map((k) => [k, seen[k]])), [key]: [...kinds, err.kind] });
  return `⚠ Jev 無法使用（${err.message}），這次照原本方式運作。`;
}

// ---------- Skill 清單 ----------

function parseSkillFile(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[^\n]*\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!km) continue;
    const k = km[1];
    let v = km[2].trim();
    if (/^[|>][-+]?$/.test(v)) {
      const buf = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) buf.push(lines[++i].trim());
      v = buf.join(v.startsWith('|') ? '\n' : ' ').trim();
    } else if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+-\s/.test(lines[i + 1])) v += ' ' + lines[++i].trim();
    }
    fm[k] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

function entry(file, fallbackName, prefix) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { fm, body } = parseSkillFile(text);
  if (String(fm['disable-model-invocation']).toLowerCase() === 'true') return null;
  const name = prefix + (fm.name || fallbackName);
  const description = (fm.description || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '').replace(/\s+/g, ' ').trim();
  return { name, description, body: body.replace(/\s+/g, ' ').trim() };
}

function skillsIn(base, prefix) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return [];
  }
  return dirs
    .filter((d) => !d.startsWith('.'))
    .map((d) => entry(path.join(base, d, 'SKILL.md'), d, prefix))
    .filter(Boolean);
}

function commandsIn(base, prefix, rel = '') {
  let items = [];
  try {
    items = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return items.flatMap((it) => {
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) return commandsIn(base, prefix, r);
    if (!it.name.endsWith('.md')) return [];
    const name = r.slice(0, -3).replace(/\//g, ':');
    if (!prefix && name === 'jev') return [];
    const e = entry(path.join(base, r), name, prefix);
    // commands 的名字一律是路徑，不吃 frontmatter 的 name
    return e ? [{ ...e, name: prefix + name }] : [];
  });
}

function roster(cwd) {
  const user = readJson(path.join(CLAUDE, 'settings.json'), {});
  const proj = cwd ? merge(readJson(path.join(cwd, '.claude', 'settings.json'), {}), readJson(path.join(cwd, '.claude', 'settings.local.json'), {})) : {};
  const overrides = { ...(user.skillOverrides || {}), ...(proj.skillOverrides || {}) };
  const enabledPlugins = { ...(user.enabledPlugins || {}), ...(proj.enabledPlugins || {}) };
  const installed = readJson(path.join(CLAUDE, 'plugins', 'installed_plugins.json'), { plugins: {} }).plugins || {};

  const list = [...skillsIn(path.join(CLAUDE, 'skills'), ''), ...commandsIn(path.join(CLAUDE, 'commands'), '')];
  for (const [id, on] of Object.entries(enabledPlugins)) {
    if (on !== true) continue;
    const inst = (installed[id] || []).find(
      (p) => p.scope === 'user' || (cwd && p.projectPath && path.resolve(p.projectPath).toLowerCase() === path.resolve(cwd).toLowerCase()),
    );
    if (!inst) continue;
    const plugin = id.split('@')[0] + ':';
    list.push(...skillsIn(path.join(inst.installPath, 'skills'), plugin), ...commandsIn(path.join(inst.installPath, 'commands'), plugin));
  }
  if (cwd) list.push(...skillsIn(path.join(cwd, '.claude', 'skills'), ''), ...commandsIn(path.join(cwd, '.claude', 'commands'), ''));

  // 後面（專案）蓋前面（使用者）；關掉的 skill 不列入。
  const byName = new Map();
  for (const s of list) if (overrides[s.name] !== 'off' && s.description) byName.set(s.name, s);
  return [...byName.values()];
}

// ---------- 判斷 ----------

const NO_SKILL = 'no_skill';

const TASK_TYPES = {
  trivial_fix: ['瑣碎修正', 'A one-line fix, a typo, or an obviously small bug fix'],
  feature_or_behavior_change: ['新功能或行為變更', 'A new feature, refactor, behavior change, or API change that needs planning before code'],
  bug_investigation: ['除錯', 'Debugging or finding the root cause of a failure or unexpected behavior'],
  code_review: ['程式碼審查', 'Reviewing code or a diff for problems before merging'],
  security_audit: ['資安檢查', 'A security review, audit, or threat modeling'],
  qa_testing: ['QA／驗收', 'Testing, QA, or checking that a feature works for users'],
  deploy_or_ship: ['出貨／部署', 'Shipping, deploying, merging, or releasing'],
  question_or_explanation: ['問答或說明', 'A question to answer or something to explain, with no changes made'],
  docs_or_writing: ['文件或寫作', 'Documents, slides, notes, or other writing that is not code'],
  config_or_environment: ['工具或環境設定', 'Configuring tools, editor or agent settings, or the development environment'],
  other: ['其他', 'Something else'],
};

const MODEL_TIERS = {
  haiku: 'Simple, mechanical, or lookup work: searching files, listing, reading a known file, short summaries, formatting, collecting facts.',
  sonnet: 'Typical engineering work of moderate difficulty: implementing a well-specified change, writing tests, routine reviews, multi-file research.',
  opus: 'Hard work that needs deep reasoning: architecture or design decisions, subtle bugs, security analysis, ambiguous or high-stakes tasks.',
};

const RISKS = {
  destructive: [
    '刪除或無法復原',
    'Would running `command` delete, overwrite, or irreversibly change files, data, git history, or system state in a way that may not be recoverable (for example deleting files, force-pushing, hard resets, dropping tables, uninstalling)?',
  ],
  outward: [
    '影響本機以外',
    'Would running `command` publish, send, deploy, push, or otherwise take effect outside this local machine (for example git push, deploying, sending messages or email, calling an API that changes remote state)?',
  ],
  secrets: ['碰到機密', 'Does `command` read, print, transmit, or change credentials, API keys, tokens, passwords, or other secrets?'],
};

// 對話紀錄最後一則助理回覆（只讀檔尾），讓「好，繼續」這類短訊息有上下文。
function lastAssistantText(transcriptPath, max) {
  if (!transcriptPath) return '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
      const text = row.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) return clip(text.length > max ? text.slice(-max) : text, max);
    }
  } catch {
    // 讀不到就沒有上下文
  }
  return '';
}

async function judgePrompt(prompt, cwd, cfg, recentContext = '') {
  const state = { request: clip(prompt, 4000), recent_context: recentContext, project_folder: cwd ? path.basename(cwd) : '' };
  const questions = {};
  const skills = cfg.features.skills ? roster(cwd) : [];
  if (skills.length) {
    questions.which = {
      type: 'choice',
      instructions:
        "Which of these skills, if any, should a coding assistant load to handle the user's latest message (`request`)? `recent_context` is the assistant's previous reply; a short follow-up such as \"ok, continue\" usually means carrying on that work, not starting a skill. Choose no_skill when none of them fits.",
      criteria: {
        ...Object.fromEntries(skills.map((s) => [s.name, clip(s.description, cfg.skills.descriptionChars)])),
        [NO_SKILL]: 'None of the listed skills fits; handle the request directly.',
      },
    };
    // 門檻問的是「要做什麼動作」，不是主題（cookbook 的提醒）。
    questions.acts = { type: 'noul', instructions: "Must the assistant act on the user's files, repository, accounts, devices, or services to fulfil `request`, rather than only explain something?" };
    questions.procedure = { type: 'noul', instructions: 'Would an expert handling `request` consult a specific documented procedure, workflow, or set of commands?' };
    questions.prose = { type: 'noul', instructions: 'Could a generalist fully satisfy `request` by writing a prose answer, without running any tools or following any procedure?' };
  }
  if (cfg.features.taskType) {
    questions.task = {
      type: 'choice',
      instructions: 'What kind of task is the user asking a coding assistant to do in `request`?',
      criteria: Object.fromEntries(Object.entries(TASK_TYPES).map(([k, [, d]]) => [k, d])),
    };
  }
  if (!Object.keys(questions).length) return { skill: null, task: null, calls: [] };

  const t0 = Date.now();
  const r1 = await jev(state, questions, cfg.timeoutMs.prompt, cfg);
  const calls = [{ ms: Date.now() - t0, usage: r1.usage }];
  const a = r1.answers;
  const out = { skill: null, task: null, calls, roster: skills.length };

  if (a.task) out.task = { type: a.task.choice, confidence: a.task.confidence };

  if (a.which) {
    const gate = (a.acts.noul + a.procedure.noul + (1 - a.prose.noul)) / 3;
    out.gate = gate;
    const known = new Map(skills.map((s) => [s.name, s]));
    const ranked = Object.entries(a.which.probabilities)
      .filter(([k]) => known.has(k))
      .sort((x, y) => y[1] - x[1])
      .slice(0, cfg.skills.shortlist);
    out.shortlist = ranked.map(([k, p]) => [k, Number(p.toFixed(3))]);
    const none = a.which.probabilities[NO_SKILL] ?? 0;
    out.noSkill = Number(none.toFixed(3));
    // 第一段認為「不需要 Skill」比任何一個 Skill 都可能時，第二段的 fits 再高也不建議。
    if (gate >= cfg.skills.gate && ranked.length && ranked[0][1] > none) {
      const picked = ranked.map(([k]) => known.get(k));
      const q2 = {
        which: {
          type: 'choice',
          instructions: 'Exactly one of these skills is the best fit for `request`. Read what each one actually does and pick it.',
          criteria: Object.fromEntries(picked.map((s) => [s.name, `${s.description}\n---\n${clip(s.body, cfg.skills.excerptChars)}`])),
        },
      };
      picked.forEach((s, i) => {
        q2[`fits${i}`] = {
          type: 'noul',
          instructions: { question: 'Does this skill do the specific thing that `request` asks for?', skill: { name: s.name, description: s.description } },
        };
      });
      const t1 = Date.now();
      const r2 = await jev(state, q2, Math.max(1000, cfg.timeoutMs.prompt - (Date.now() - t0)), cfg);
      calls.push({ ms: Date.now() - t1, usage: r2.usage });
      const fits = picked.map((s, i) => [s.name, r2.answers[`fits${i}`].noul]);
      out.fits = fits.map(([k, v]) => [k, Number(v.toFixed(3))]);
      const best = Math.max(...fits.map(([, v]) => v));
      if (best >= cfg.skills.fits) {
        const name = r2.answers.which.choice;
        out.skill = { name, fit: fits.find(([k]) => k === name)?.[1] ?? best, confidence: r2.answers.which.confidence };
      }
    }
  }
  return out;
}

function promptContext(j, cfg) {
  const lines = [];
  if (j.task && j.task.type !== 'other' && j.task.confidence >= cfg.taskType.minConfidence) {
    lines.push(`任務類型：${TASK_TYPES[j.task.type]?.[0] ?? j.task.type}（信心 ${pct(j.task.confidence)}）`);
  }
  if (j.roster) {
    lines.push(
      j.skill
        ? `建議 Skill：${j.skill.name}（契合度 ${pct(j.skill.fit)}）。這是判斷建議，不適合這次的請求就忽略。`
        : '沒有特別適合這次請求的 Skill。',
    );
  }
  if (!lines.length) return null;
  return `<jev_judgment source="TypeSafe Jev">\n${lines.join('\n')}\n</jev_judgment>`;
}

async function judgeAgent(input, cfg) {
  const state = { agent_type: input.subagent_type || 'general-purpose', task_description: input.description || '', task_prompt: clip(input.prompt || '', 3000) };
  const r = await jev(
    state,
    { tier: { type: 'choice', instructions: 'Which model tier should run this delegated sub-task (`task_prompt`)? Pick the cheapest tier that can do it well.', criteria: MODEL_TIERS } },
    cfg.timeoutMs.tool,
    cfg,
  );
  return { tier: r.answers.tier.choice, confidence: r.answers.tier.confidence, usage: r.usage };
}

// 明顯唯讀、沒有串接或重導向的指令不送 Jev（程式能判斷的規則留在程式）。
const READ_ONLY = /^(git (status|log|diff|show|branch|remote -v|rev-parse)|ls|dir|pwd|cat|head|tail|wc|echo|which|where|node --version|npm --version|Get-ChildItem|Get-Content|Get-Location|Test-Path|Select-String|Get-Command)\b/i;

const anyMatch = (patterns, s) => (patterns || []).some((p) => {
  try {
    return new RegExp(p, 'i').test(s);
  } catch {
    return false; // 寫錯的 regex 當作不符合，不影響判斷
  }
});

async function judgeRisk(command, shell, cwd, cfg) {
  const cmd = command.trim();
  if (READ_ONLY.test(cmd) && !/[;&|<>`]|\$\(/.test(cmd)) return { skipped: true };
  if (anyMatch(cfg.shellRisk.exempt, cmd) && !anyMatch(cfg.shellRisk.neverExempt, cmd)) return { skipped: true, exempt: true };
  const state = { shell, working_directory: cwd || '', command: clip(cmd, 2000) };
  const questions = Object.fromEntries(Object.entries(RISKS).map(([k, [, q]]) => [k, { type: 'noul', instructions: q }]));
  const r = await jev(state, questions, cfg.timeoutMs.tool, cfg);
  return { risks: Object.fromEntries(Object.keys(RISKS).map((k) => [k, r.answers[k].noul])), usage: r.usage };
}

// ---------- 開關指令 ----------

function status(cfg) {
  const st = readJson(STATE, { enabled: false });
  const m = st.mode === 'lite' ? 'lite' : 'full';
  const on =Object.entries(cfg.features).filter(([, v]) => v).map(([k]) => ({ skills: 'Skill 篩選', taskType: '任務類型', agentModel: '子代理模型', shellRisk: 'Shell 風險把關' })[k]);
  const lines = [
    `Jev 開關：${st.enabled ? `開啟・${MODE_LABEL[m]}` : '關閉'}${st.updatedAt ? `（${st.updatedAt} 改）` : ''}`,
    `金鑰 TYPESAFE_API_KEY：${apiKey().key ? `已設定（${apiKey().source}）` : '未設定（開啟也不會生效，會警告後照原本方式運作）'}`,
    `模型：${cfg.model}；判斷項目：${on.join('、') || '無'}`,
    `門檻：Skill gate ${cfg.skills.gate}／fits ${cfg.skills.fits}、任務類型 ${cfg.taskType.minConfidence}、子代理模型 ${cfg.agentModel.minConfidence}、Shell 風險 ${cfg.shellRisk.ask}（只看 ${(cfg.shellRisk.askOn || Object.keys(RISKS)).map((k) => RISKS[k]?.[0] ?? k).join('、')}）`,
    ...(st.enabled && m === 'lite' ? ['提示模式下不跑：子代理模型、Shell 風險把關'] : []),
    `Shell 豁免：${(cfg.shellRisk.exempt || []).length} 條；即使符合豁免也照送：${(cfg.shellRisk.neverExempt || []).length} 條`,
    `設定檔：${CONFIG}`,
  ];
  return lines.join('\n');
}

function recent(n) {
  let text = '';
  try {
    text = fs.readFileSync(LOG, 'utf8');
  } catch {
    return '還沒有紀錄。';
  }
  const rows = text.trim().split('\n').slice(-n);
  return rows.length ? rows.join('\n') : '還沒有紀錄。';
}

async function runCli(args, cwd) {
  const cfg = config();
  const [cmd = 'status', ...rest] = args;
  switch (cmd) {
    case 'on':
    case 'lite':
    case 'off':
      writeJson(STATE, { enabled: cmd !== 'off', mode: cmd === 'lite' ? 'lite' : 'full', updatedAt: new Date().toISOString() });
      if (!fs.existsSync(CONFIG)) writeJson(CONFIG, DEFAULTS);
      return status(cfg);
    case 'status':
      return status(cfg);
    case 'log':
      return recent(Math.max(1, Number(rest[0]) || 10));
    case 'test': {
      // 「--context 前文 ||| 訊息」可模擬上一則助理回覆
      const joined = rest.join(' ').trim();
      const [ctx, text] = joined.startsWith('--context ') && joined.includes('|||') ? joined.slice(10).split('|||').map((s) => s.trim()) : ['', joined];
      if (!text) return '用法：/jev test [--context 上一則回覆 |||] <要判斷的文字>';
      const out = [`roster：${roster(cwd).length} 個 Skill`];
      try {
        const p = await judgePrompt(text, cwd, cfg, ctx);
        out.push(`任務類型：${p.task ? `${p.task.type}（${pct(p.task.confidence)}）` : '—'}`);
        if (p.gate !== undefined) out.push(`Skill gate：${pct(p.gate)}；不需要 Skill：${p.noSkill}；前幾名：${JSON.stringify(p.shortlist)}`);
        if (p.fits) out.push(`契合度：${JSON.stringify(p.fits)}`);
        out.push(`建議 Skill：${p.skill ? `${p.skill.name}（契合度 ${pct(p.skill.fit)}）` : '無'}`);
        const ag = await judgeAgent({ description: 'test', prompt: text }, cfg);
        out.push(`若當子代理任務：${ag.tier}（${pct(ag.confidence)}）`);
        const rk = await judgeRisk(text, 'Bash', cwd, cfg);
        out.push(`若當 Shell 指令：${rk.exempt ? '符合豁免、略過' : rk.skipped ? '唯讀、略過' : Object.entries(rk.risks).map(([k, v]) => `${RISKS[k][0]} ${pct(v)}`).join('、')}`);
      } catch (e) {
        out.push(`Jev 呼叫失敗：${e.message}`);
      }
      return out.join('\n');
    }
    default:
      return '用法：/jev on｜lite｜off｜status｜test <文字>｜log [筆數]（lite＝只留 Skill 建議與任務類型）';
  }
}

const JEV_COMMAND = /^\s*\/jev(?:\s+([\s\S]*))?$/;
const splitArgs = (s) => (s || '').trim().split(/\s+/).filter(Boolean);

// ---------- hooks ----------

async function runHook(kind, input) {
  const cfg = config();
  const sid = input.session_id;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || '';

  // /jev 指令由 hook 處理並擋下，不送給模型。開關關著也要能用。
  if (kind === 'expansion') {
    if (input.command_name !== 'jev') return null;
    const args = Array.isArray(input.command_args) ? input.command_args : splitArgs(input.command_args);
    return { decision: 'block', reason: await runCli(args, cwd) };
  }
  if (kind === 'prompt') {
    const m = (input.prompt || '').match(JEV_COMMAND);
    if (m) return { decision: 'block', reason: await runCli(splitArgs(m[1]), cwd), hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } };
  }

  if (!enabled()) return null;

  try {
    if (kind === 'prompt') {
      const prompt = (input.prompt || '').trim();
      // 使用者自己指定了 skill／指令，就不再判斷
      if (prompt.startsWith('/') || prompt.length < cfg.skills.minPromptChars) return null;
      if (!cfg.features.skills && !cfg.features.taskType) return null;
      const j = await judgePrompt(prompt, cwd, cfg, lastAssistantText(input.transcript_path, 1500));
      log({ hook: 'prompt', session: sid, prompt: clip(prompt, 200), task: j.task, gate: j.gate, noSkill: j.noSkill, shortlist: j.shortlist, fits: j.fits, skill: j.skill, calls: j.calls });
      const ctx = promptContext(j, cfg);
      return ctx ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } } : null;
    }

    if (kind === 'agent') {
      if (jevMode() === 'lite') return null;
      const ti = input.tool_input || {};
      // 已明確指定模型、或 fork（不能換模型）就尊重原本的選擇
      if (!cfg.features.agentModel || ti.model || ti.subagent_type === 'fork') return null;
      const j = await judgeAgent(ti, cfg);
      const apply = j.confidence >= cfg.agentModel.minConfidence;
      log({ hook: 'agent', session: sid, description: clip(ti.description || '', 120), tier: j.tier, confidence: j.confidence, applied: apply, usage: j.usage });
      if (!apply) return null;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Jev 選擇子代理模型 ${j.tier}（信心 ${pct(j.confidence)}）`,
          updatedInput: { ...ti, model: j.tier },
        },
      };
    }

    if (kind === 'risk') {
      if (!cfg.features.shellRisk || jevMode() === 'lite') return null;
      const command = input.tool_input?.command;
      if (typeof command !== 'string' || !command.trim()) return null;
      const j = await judgeRisk(command, input.tool_name, cwd, cfg);
      if (j.skipped) return null;
      const askOn = cfg.shellRisk.askOn || Object.keys(RISKS);
      const hits = Object.entries(j.risks).filter(([k, v]) => askOn.includes(k) && v >= cfg.shellRisk.ask);
      log({ hook: 'risk', session: sid, command: clip(command, 200), risks: j.risks, ask: hits.length > 0, usage: j.usage });
      if (!hits.length) return null; // 不放行、不擋，交回原本的權限流程
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Jev 判斷這個指令可能${hits.map(([k, v]) => `${RISKS[k][0]}（${pct(v)}）`).join('、')}，請確認。`,
        },
      };
    }
  } catch (e) {
    const err = e instanceof JevError ? e : new JevError('internal', String(e?.message ?? e));
    log({ hook: kind, session: sid, error: err.kind, message: err.message });
    const msg = warnOnce(sid, err);
    return msg ? { systemMessage: msg } : null;
  }
  return null;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data || '{}');
  } catch {
    return {};
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'hook') {
  const out = await runHook(args[0], await readStdin()).catch(() => null);
  if (out) process.stdout.write(JSON.stringify(out));
  // 不呼叫 process.exit()：Windows 上 fetch 的連線還在關閉時 exit 會觸發 libuv 斷言而以非 0 結束。
  process.exitCode = 0;
} else if (mode === 'cli') {
  process.stdout.write((await runCli(args, process.cwd())) + '\n');
} else {
  process.stdout.write('用法：node jev.mjs hook <prompt|expansion|agent|risk> 或 node jev.mjs cli <on|lite|off|status|test|log>\n');
}
