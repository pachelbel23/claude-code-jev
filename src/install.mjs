// 安裝 Jev 開關：在 ~/.claude/settings.json 加上 hooks（先備份），並建立 ~/.claude/commands/jev.md。
// 可重複執行；已存在的項目不會重複加，不刪除任何東西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const SCRIPT = path.join(CLAUDE, 'jev', 'jev.mjs').replace(/\\/g, '/');
const cmd = (kind) => `node "${SCRIPT}" hook ${kind}`;

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
  if (list.some((g) => g.hooks?.some((h) => h.command === cmd(kind)))) continue;
  list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(kind), timeout }] });
  console.log(`加入 ${event}${matcher ? ` [${matcher}]` : ''} → ${kind}`);
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

const commandFile = path.join(CLAUDE, 'commands', 'jev.md');
if (!fs.existsSync(commandFile)) {
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  fs.writeFileSync(
    commandFile,
    `---
description: Jev 開關：on｜off｜status｜test <文字>｜log [筆數]
argument-hint: on|off|status|test <文字>|log [n]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---
!\`node "${SCRIPT}" cli $ARGUMENTS\`

把上面的輸出原樣顯示給使用者，不要補充或判斷。
`,
  );
  console.log(`建立 ${commandFile}`);
}
console.log(`完成。settings.json 備份在 ${backup}`);
