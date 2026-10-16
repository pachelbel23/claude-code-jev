// 產生跨平台一鍵安裝檔 setup-jev.mjs（給「別台電腦」用）：把 Jev 原始檔與 jev-vision 打包成單一檔案。
//
//   node build-setup.mjs                                # 預設：打包本資料夾的 windows/ + shared/，輸出 setup-jev.mjs
//   node build-setup.mjs --src <dir,dir> --out <file>   # 指定來源資料夾（依序找檔）與輸出位置
//
// 需要的檔案：jev.mjs、install.mjs、config.json、command-jev.md、jev-vision.mjs、SKILL-jev-vision.md
// 不打包：state.json、log.jsonl、warned.json、任何金鑰。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const srcDirs = opt('--src', `${path.join(HERE, 'windows')},${path.join(HERE, 'shared')}`).split(',').map((d) => path.resolve(d));
const out = path.resolve(opt('--out', path.join(HERE, 'setup-jev.mjs')));

function find(name) {
  for (const d of srcDirs) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  throw new Error(`在 ${srcDirs.join('、')} 找不到 ${name}`);
}
const b64 = (name) => fs.readFileSync(find(name)).toString('base64');
const cmdTemplate = fs.readFileSync(find('command-jev.md'), 'utf8').replace(/node "[^"]*jev\.mjs"/, 'node "__JEV_SCRIPT__"');
if (!cmdTemplate.includes('__JEV_SCRIPT__')) throw new Error('command-jev.md 找不到 node "...jev.mjs" 這段，無法換成目標機路徑');

const bundle = {
  'jev.mjs': b64('jev.mjs'),
  'config.json': b64('config.json'),
  'install.mjs': b64('install.mjs'),
  'jev-vision.mjs': b64('jev-vision.mjs'),
  'SKILL-jev-vision.md': b64('SKILL-jev-vision.md'),
  'jev.md': Buffer.from(cmdTemplate).toString('base64'),
};

const setup = `#!/usr/bin/env node
// Jev for Claude Code — one-file installer (Windows / WSL / Linux / macOS). Requires Node.js 18+.
// Jev 一鍵安裝（TypeSafe System One hooks + jev-vision 圖片工具）。由 build-setup.mjs 產生，請勿手改。
//
//   node setup-jev.mjs [--mode lite|on|off] [--key-file <file>] [--no-gui]
//   node setup-jev.mjs --key-only                 # 只（重新）設定金鑰
//
// Installs into ~/.claude: jev/jev.mjs (hooks), jev/jev-vision.mjs (Images + Box CLI), skills/jev-vision/SKILL.md,
// commands/jev.md (/jev), and 4 hooks in settings.json (backed up first).
// API key → ~/.claude/jev/api_key (owner-only). Never printed, never logged, never in this file.
// Re-runnable. Existing files that differ are backed up as .bak-<time>; nothing is deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BUNDLE = ${JSON.stringify(bundle, null, 2)};

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = opt('--mode') ?? 'lite';
const keyFileArg = opt('--key-file');
const noGui = args.includes('--no-gui');
const keyOnly = args.includes('--key-only');
if (!['lite', 'on', 'off'].includes(mode)) die('--mode must be lite, on or off（只能是 lite、on、off）');
if (Number(process.versions.node.split('.')[0]) < 18) die('Node.js 18+ required（需要 Node.js 18 以上）');

function die(msg) { console.error('ERROR 錯誤：' + msg); process.exit(1); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const fromB64 = (k) => Buffer.from(BUNDLE[k], 'base64');
function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file).equals(Buffer.from(data))) return;
    fs.copyFileSync(file, file + '.bak-' + stamp);
  }
  fs.writeFileSync(file, data);
}
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

const CLAUDE = path.join(os.homedir(), '.claude');
const DIR = path.join(CLAUDE, 'jev');
const SCRIPT = path.join(DIR, 'jev.mjs');
const KEY_FILE = process.env.TYPESAFE_API_KEY_FILE || path.join(DIR, 'api_key');
const isWSL = process.platform === 'linux' && /microsoft/i.test(safeRead('/proc/version'));

console.log(\`Platform 平台：\${process.platform}\${isWSL ? ' (WSL)' : ''}, Node \${process.version}, home \${os.homedir()}\`);

if (!keyOnly) {
  if (fs.existsSync(path.join(DIR, 'jev.py'))) {
    die(\`\${DIR} already has the Python Jev (jev.py); installing the Node version would duplicate hooks.（已有 Python 版 Jev，裝 Node 版會產生重複 hooks）\`);
  }
  console.log('1/6 Files 寫入 Jev 檔案...');
  put(SCRIPT, fromB64('jev.mjs'));
  put(path.join(DIR, 'config.json'), fromB64('config.json'));
  put(path.join(DIR, 'install.mjs'), fromB64('install.mjs'));

  console.log('2/6 Images + Box 圖片工具 jev-vision...');
  put(path.join(DIR, 'jev-vision.mjs'), fromB64('jev-vision.mjs'));
  put(path.join(CLAUDE, 'skills', 'jev-vision', 'SKILL.md'), fromB64('SKILL-jev-vision.md'));

  console.log('3/6 /jev command 指令...');
  put(path.join(CLAUDE, 'commands', 'jev.md'),
    fromB64('jev.md').toString('utf8').replace('__JEV_SCRIPT__', SCRIPT.replace(/\\\\/g, '/')));

  console.log('4/6 Hooks 掛上 Claude Code hooks...');
  const settings = path.join(CLAUDE, 'settings.json');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, '{}\\n');
  const r = spawnSync(process.execPath, [path.join(DIR, 'install.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) die('install.mjs failed 失敗');

  console.log('5/6 Mode 模式：' + mode);
  fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(
    { enabled: mode !== 'off', mode: mode === 'lite' ? 'lite' : 'full', updatedAt: new Date().toISOString() }, null, 2) + '\\n');
}

console.log('6/6 API key 金鑰...');
let key = '';
if (keyFileArg) key = safeRead(keyFileArg).split(/\\r?\\n/)[0].trim();
else {
  key = noGui || process.env.SSH_CONNECTION ? null : guiPrompt();
  if (key === null) key = await askHidden('Paste TYPESAFE_API_KEY (hidden; Enter = keep current) 請輸入金鑰（不顯示；直接 Enter = 保留）：');
}
if (key) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, key + '\\n', { mode: 0o600 });
  if (process.platform === 'win32') {
    spawnSync('icacls', [KEY_FILE, '/inheritance:r', '/grant:r', \`\${process.env.USERNAME}:F\`], { stdio: 'ignore' });
  } else {
    fs.chmodSync(KEY_FILE, 0o600);
  }
  console.log('   Saved 已寫入 ' + KEY_FILE + ' (owner-only 只限本人)');
} else if (fs.existsSync(KEY_FILE)) {
  console.log('   Keeping existing key file 沿用既有金鑰檔 ' + KEY_FILE);
} else if (process.env.TYPESAFE_API_KEY) {
  console.log('   Using env TYPESAFE_API_KEY 沿用環境變數');
} else {
  console.warn('   No key yet. Jev will warn and stay out of the way. Re-run with --key-only later.（未設定金鑰：之後用 --key-only 補上）');
}
if (key && process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim() !== key) {
  console.warn('   Note: env TYPESAFE_API_KEY is set and takes precedence over the key file.（環境變數優先於金鑰檔）');
}
key = '';

console.log('');
if (fs.existsSync(SCRIPT)) spawnSync(process.execPath, [SCRIPT, 'cli', 'status'], { stdio: 'inherit' });
console.log('\\nDone. Restart Claude Code to load the hooks and the jev-vision skill.（完成，請重開 Claude Code）');

// Password dialog. Returns the text (OK pressed; may be ''), or null when no dialog tool is available.
function guiPrompt() {
  const title = 'Jev - TypeSafe API Key';
  const label = 'Paste TYPESAFE_API_KEY (empty = keep current)';
  const ps = \`Add-Type -AssemblyName System.Windows.Forms;
$f=New-Object Windows.Forms.Form -Property @{Text='\${title}';Width=440;Height=150;StartPosition='CenterScreen';TopMost=$true;FormBorderStyle='FixedDialog';MaximizeBox=$false;MinimizeBox=$false};
$l=New-Object Windows.Forms.Label -Property @{Text='\${label}';Left=12;Top=12;Width=400};
$t=New-Object Windows.Forms.TextBox -Property @{Left=12;Top=36;Width=400;UseSystemPasswordChar=$true};
$b=New-Object Windows.Forms.Button -Property @{Text='OK';Left=337;Top=70;Width=75;DialogResult='OK'};
$f.Controls.AddRange(@($l,$t,$b));$f.AcceptButton=$b;
if($f.ShowDialog() -eq 'OK'){[Console]::Out.Write($t.Text)}\`;
  const tries = [];
  if (process.platform === 'win32' || isWSL) {
    tries.push([process.platform === 'win32' ? 'powershell' : 'powershell.exe', ['-NoProfile', '-STA', '-Command', ps]]);
  } else if (process.platform === 'darwin') {
    tries.push(['osascript', ['-e', \`display dialog "\${label}" default answer "" with hidden answer with title "\${title}"\`, '-e', 'text returned of result']]);
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    tries.push(['zenity', ['--password', '--title', title]], ['kdialog', ['--password', label, '--title', title]]);
  }
  for (const [cmd, a] of tries) {
    const p = spawnSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (p.error) continue;
    return (p.stdout || '').trim();
  }
  return null;
}

// Hidden terminal input (no echo).
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { console.warn('   No terminal for input; use --key-file or run --key-only in a real terminal.（沒有終端機可輸入）'); return resolve(''); }
    process.stdout.write('   ' + prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\\n'); resolve(s.trim()); };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\\r' || c === '\\n') return done();
        if (c === '\\u0003') { stdin.setRawMode(false); process.exit(130); }
        if (c === '\\u007f' || c === '\\b') { s = s.slice(0, -1); continue; }
        s += c;
      }
    };
    stdin.on('data', onData);
  });
}
`;

fs.writeFileSync(out, setup);
console.log(`已產生 ${out}（${(setup.length / 1024).toFixed(0)} KB）`);
