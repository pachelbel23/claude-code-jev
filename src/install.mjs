// 安裝 Jev 開關：在 ~/.claude/settings.json 加上 hooks（先備份），並建立 ~/.claude/commands/jev.md。
// 可重複執行；已存在的項目不會重複加，不刪除任何東西。
// Windows 以外用安裝當下 node 的絕對路徑：hook 與 /jev 的 ! 指令跑在非互動 shell，nvm 這類只在 .bashrc 載入的 node 會找不到。
// 換了 node 版本（例如 nvm use 別版）要重跑本檔；已裝的舊路徑會就地改掉，不會重複。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const SCRIPT = path.join(CLAUDE, 'jev', 'jev.mjs').replace(/\\/g, '/');
const NODE = process.platform === 'win32' ? 'node' : /\s/.test(process.execPath) ? JSON.stringify(process.execPath) : process.execPath;
const cmd = (kind) => `${NODE} "${SCRIPT}" hook ${kind}`;
const ours = (command, kind) => typeof command === 'string' && command.endsWith(`"${SCRIPT}" hook ${kind}`);

const raw = fs.readFileSync(SETTINGS, 'utf8');
const backup = `${SETTINGS}.bak-jev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.writeFileSync(backup, raw);
const settings = JSON.parse(raw);
settings.hooks ??= {};

const wanted = [
  ['UserPromptSubmit', undefined, 'prompt', 20],
  ['UserPromptExpansion', 'jev', 'expansion', 10],
  ['PreToolUse', 'Agent|Task', 'agent', 10],
  ['PreToolUse', 'Bash|PowerShell', 'risk', 10],
];
for (const [event, matcher, kind, timeout] of wanted) {
  const list = (settings.hooks[event] ??= []);
  const existing = list.flatMap((g) => g.hooks ?? []).filter((h) => ours(h.command, kind));
  if (existing.length) {
    for (const h of existing) {
      if (h.command === cmd(kind)) continue;
      console.log(`更新 ${event} → ${kind}：${h.command} → ${cmd(kind)}`);
      h.command = cmd(kind);
    }
    continue;
  }
  list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(kind), timeout }] });
  console.log(`加入 ${event}${matcher ? ` [${matcher}]` : ''} → ${kind}`);
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

const commandFile = path.join(CLAUDE, 'commands', 'jev.md');
const allowed = NODE === 'node' ? 'Bash(node:*)' : `Bash(node:*), Bash(${NODE}:*)`;
if (!fs.existsSync(commandFile)) {
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  fs.writeFileSync(
    commandFile,
    `---
description: Jev 開關：on｜off｜status｜test <文字>｜log [筆數]
argument-hint: on|off|status|test <文字>|log [n]
allowed-tools: ${allowed}
disable-model-invocation: true
---
!\`${NODE} "${SCRIPT}" cli $ARGUMENTS\`

把上面的輸出原樣顯示給使用者，不要補充或判斷。
`,
  );
  console.log(`建立 ${commandFile}`);
} else {
  // 既有的 /jev 指令（setup-jev.mjs 剛寫入的、或舊版裝的）改用同一個 node。
  const text = fs.readFileSync(commandFile, 'utf8');
  const fixed = text
    .replace(/!`(?:"[^"]*"|\S+) ("[^"]*jev\.mjs" cli )/, (_, rest) => `!\`${NODE} ${rest}`)
    .replace(/^allowed-tools: .*$/m, `allowed-tools: ${allowed}`);
  if (fixed !== text) {
    fs.copyFileSync(commandFile, `${commandFile}.bak-jev-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(commandFile, fixed);
    console.log(`更新 ${commandFile}（node：${NODE}）`);
  }
}
if (NODE !== 'node') console.log(`hooks 與 /jev 使用 ${NODE}；之後換 node 版本請重跑本檔。`);
console.log(`完成。settings.json 備份在 ${backup}`);
