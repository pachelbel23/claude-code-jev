#!/usr/bin/env node
// Jev Vision：用 TypeSafe Jev 對「圖片檔」做型別化判斷（Images + Box，danger zone 實驗功能）。
// Windows / WSL / Linux / macOS 通用，只需 Node 18+；不依賴 Jev hooks（Node 版或 Python 版皆可並存）。
//
//   node jev-vision.mjs ask    <圖...> "<是非題>"                     → Noul（機率）
//   node jev-vision.mjs choose <圖...> "<問題>" 選項=說明 [選項=說明…]  → Choice（選項 + 各選項機率）
//   node jev-vision.mjs box    <圖>    "<要找的東西>"                   → 先 Noul 問有沒有，再 Box 回傳外框（比例 + 像素）
//   共用參數：--model <id>（預設 ask/choose 用 jev-latest，box 用 jev-1.14.0）  --json（輸出原始回應）
//
// 多張圖依序叫 `img1`、`img2`…，問題裡可直接寫 `img1`（含反引號）指定是哪張；只有一張時寫「這張圖」也可以。
// 金鑰：環境變數 TYPESAFE_API_KEY 優先；沒有就讀 ~/.claude/jev/api_key（或 TYPESAFE_API_KEY_FILE）。
// 圖片限制：PNG/JPEG 靜態圖、長寬 280–1568 px。超出範圍時自動用本機工具轉檔（Windows/WSL：System.Drawing；
// 其他：ImageMagick `magick`，macOS 退而用 `sips`），找不到工具就報錯請你先自己縮放。
// 注意：這是 TypeSafe 的實驗功能（Dreamer-ready），不適合正式決策；圖片會上傳到 TypeSafe，機密圖片先確認能不能外傳。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const API = 'https://api.typesafe.ai/v1/systemone';
const KEY_FILE = process.env.TYPESAFE_API_KEY_FILE || path.join(os.homedir(), '.claude', 'jev', 'api_key');
const MIN = 280;
const MAX = 1568;
const MAX_FILE = 16 * 1024 * 1024;

function die(msg, code = 1) {
  console.error('錯誤：' + msg);
  process.exit(code);
}

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

// ---------- 讀圖片標頭：格式、長寬、是否動畫、EXIF 方向 ----------

function inspect(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const info = { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), animated: false, orientation: 1 };
    for (let p = 8; p + 8 <= buf.length; ) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      if (type === 'acTL') info.animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
    return info;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const info = { format: 'jpg', width: 0, height: 0, animated: false, orientation: 1, progressive: false };
    for (let p = 2; p + 4 <= buf.length; ) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') info.orientation = exifOrientation(buf, p + 10);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        info.height = buf.readUInt16BE(p + 5);
        info.width = buf.readUInt16BE(p + 7);
        info.progressive = marker === 0xc2;
      }
      p += 2 + len;
    }
    return info;
  }
  return null;
}

function exifOrientation(buf, tiff) {
  try {
    const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = tiff + u32(tiff + 4);
    for (let i = 0, n = u16(ifd); i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch {}
  return 1;
}

// ---------- 轉檔：縮放到範圍內、轉正 ----------

const isWSL = process.platform === 'linux' && /microsoft/i.test(safeRead('/proc/version'));
function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
const has = (cmd) => !spawnSync(cmd, ['-version'], { stdio: 'ignore' }).error;

// System.Drawing：套用 EXIF 方向、等比縮放到 [MIN, MAX]，存成 baseline JPEG。
const PS_FIX = `param($in,$out,$min,$max)
Add-Type -AssemblyName System.Drawing
$img=[Drawing.Image]::FromFile($in)
try { $o=$img.GetPropertyItem(0x0112).Value[0] } catch { $o=1 }
$map=@{2='RotateNoneFlipX';3='Rotate180FlipNone';4='Rotate180FlipX';5='Rotate90FlipX';6='Rotate90FlipNone';7='Rotate270FlipX';8='Rotate270FlipNone'}
if($map.ContainsKey([string]$o)){ $img.RotateFlip($map[[string]$o]) }
$w=$img.Width;$h=$img.Height
$s=[Math]::Min(1.0,[Math]::Min($max/$w,$max/$h)); if([Math]::Min($w*$s,$h*$s) -lt $min){ $s=$min/[Math]::Min($w,$h) }
$nw=[int][Math]::Min($max,[Math]::Round($w*$s));$nh=[int][Math]::Min($max,[Math]::Round($h*$s))
$b=New-Object Drawing.Bitmap $nw,$nh; $g=[Drawing.Graphics]::FromImage($b)
$g.InterpolationMode='HighQualityBicubic'; $g.DrawImage($img,0,0,$nw,$nh)
$enc=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}
$ep=New-Object Drawing.Imaging.EncoderParameters 1; $ep.Param[0]=New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality),90L
$b.Save($out,$enc,$ep); $g.Dispose(); $b.Dispose(); $img.Dispose()`;

function fixImage(file) {
  const out = path.join(os.tmpdir(), `jev-vision-${crypto.randomUUID()}.jpg`);
  const tries = [];
  if (process.platform === 'win32' || isWSL) {
    const ps1 = path.join(os.tmpdir(), `jev-vision-fix-${process.pid}.ps1`);
    fs.writeFileSync(ps1, PS_FIX);
    const win = (p) => (isWSL ? spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim() : p);
    tries.push(() => spawnSync(isWSL ? 'powershell.exe' : 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', win(ps1), win(path.resolve(file)), win(out), MIN, MAX], { stdio: 'ignore' }));
  }
  if (has('magick')) tries.push(() => spawnSync('magick', [file, '-auto-orient', '-resize', `${MAX}x${MAX}>`, '-resize', `${MIN}x${MIN}^<`, '-strip', '-interlace', 'none', '-quality', '90', out], { stdio: 'ignore' }));
  if (process.platform === 'darwin') tries.push(() => spawnSync('sips', ['-s', 'format', 'jpeg', '-Z', String(MAX), file, '--out', out], { stdio: 'ignore' }));
  for (const t of tries) {
    const r = t();
    if (!r.error && r.status === 0 && fs.existsSync(out)) return out;
  }
  return null;
}

function loadImage(file) {
  if (!fs.existsSync(file)) die(`找不到圖片 ${file}`);
  let buf = fs.readFileSync(file);
  let info = inspect(buf);
  if (!info) die(`${file} 不是 PNG 或 JPEG（GIF/WebP/HEIC 請先轉成 PNG 或 JPEG）`);
  // 只縮放未旋轉時，Box 的比例可直接換算回原圖像素。
  const orig = info.orientation === 1 ? { width: info.width, height: info.height } : null;
  if (info.animated) die(`${file} 是動畫 PNG，請先匯出單一畫格`);
  const outOfRange = info.width < MIN || info.height < MIN || info.width > MAX || info.height > MAX;
  const needFix = outOfRange || info.orientation !== 1 || buf.length > MAX_FILE;
  if (needFix) {
    const fixed = fixImage(file);
    if (fixed) {
      const reason = [outOfRange && `尺寸 ${info.width}×${info.height}`, info.orientation !== 1 && `EXIF 方向 ${info.orientation}`].filter(Boolean).join('、');
      buf = fs.readFileSync(fixed);
      fs.rmSync(fixed, { force: true });
      info = inspect(buf);
      console.error(`（${path.basename(file)}：${reason} → 已轉成 ${info.width}×${info.height} JPEG 再上傳，原檔未變更）`);
    } else if (outOfRange) {
      die(`${file} 是 ${info.width}×${info.height}，長寬需在 ${MIN}–${MAX} px；本機找不到可轉檔的工具，請先自行縮放`);
    } else if (info.orientation !== 1) {
      console.error(`（警告：${path.basename(file)} 的 EXIF 方向是 ${info.orientation}，API 不會自動轉正，模型看到的可能是橫的）`);
    }
  }
  if (info.progressive) console.error(`（提示：${path.basename(file)} 是 progressive JPEG，被拒時請另存成 baseline）`);
  return { buf, info, orig, name: path.basename(file) };
}

// ---------- 呼叫 API ----------

async function call(model, images, questions) {
  const key = apiKey();
  if (!key) die(`沒有設定 TYPESAFE_API_KEY，也找不到金鑰檔 ${KEY_FILE}`);
  const state = {};
  const assets = {};
  images.forEach((img, i) => {
    const ref = `img-${crypto.randomUUID()}`;
    state[`img${i + 1}`] = ref;
    assets[ref] = { type: 'image', part: `p${i + 1}` };
  });
  // multipart：第一個 part 必須是 request（JSON），之後每張圖各一個 part。
  const fd = new FormData();
  fd.append('request', new Blob([JSON.stringify({ model, state, assets, questions })], { type: 'application/json' }));
  images.forEach((img, i) =>
    fd.append(`p${i + 1}`, new Blob([img.buf], { type: img.info.format === 'png' ? 'image/png' : 'image/jpeg' }), img.name),
  );
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'TypeSafe-Danger-Zone-Images': 'true' },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) die(`API ${res.status}：${text.slice(0, 500)}`, 2);
  return JSON.parse(text);
}

// ---------- 指令 ----------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const asJson = argv.includes('--json') && (argv.splice(argv.indexOf('--json'), 1), true);
const modelArg = flag('--model');
const [cmd, ...rest] = argv;
const isImage = (a) => /\.(png|jpe?g)$/i.test(a);
const pct = (p) => `${Math.round(p * 100)}%`;
const which = (n) => (n === 1 ? '`img1`（這張圖）' : `\`img1\`…\`img${n}\``);

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const files = rest.filter(isImage);
  const words = rest.filter((a) => !isImage(a));
  if (!files.length) die('至少要給一張 PNG 或 JPEG 圖片路徑');
  const images = files.map(loadImage);
  const hint = `（圖片在 state 中依序為 ${which(images.length)}）`;

  if (cmd === 'ask') {
    const q = words.join(' ');
    if (!q) die('請給一個是非題');
    const r = await call(modelArg || 'jev-latest', images, { q: { type: 'noul', instructions: `${q}${hint}` } });
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const p = r.answers.q.noul;
    console.log(`${p >= 0.5 ? '是' : '否'}（是的機率 ${pct(p)}）  model=${r.model}  tokens=${r.usage?.input_tokens}+${r.usage?.output_tokens}`);
  } else if (cmd === 'choose') {
    const [q, ...opts] = words;
    const criteria = Object.fromEntries(opts.map((o) => { const i = o.indexOf('='); return i > 0 ? [o.slice(0, i), o.slice(i + 1)] : [o, o]; }));
    if (!q || Object.keys(criteria).length < 2) die('用法：choose <圖...> "<問題>" 選項=說明 選項=說明 …（至少兩個選項）');
    const r = await call(modelArg || 'jev-latest', images, { q: { type: 'choice', instructions: `${q}${hint}`, criteria } });
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const a = r.answers.q;
    console.log(`${a.choice}（信心 ${pct(a.confidence)}）  model=${r.model}`);
    for (const [k, v] of Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(20)} ${pct(v)}`);
  } else if (cmd === 'box') {
    const target = words.join(' ');
    if (!target) die('請說明要找什麼，例如 "the product label"');
    if (images.length !== 1) die('box 一次只接受一張圖');
    const r = await call(modelArg || 'jev-1.14.0', images, {
      present: { type: 'noul', instructions: `Is there ${target} in \`img1\`?` },
      where: { type: 'box', instructions: `${target} in \`img1\`` },
    });
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const present = r.answers.present.noul;
    const { box, confidence } = r.answers.where;
    const ref = images[0].orig || images[0].info;
    const { width: w, height: h } = ref;
    const px = [box.left * w, box.top * h, box.right * w, box.bottom * h].map(Math.round);
    console.log(`存在機率 ${pct(present)}${present < 0.5 ? '  ⚠ 可能根本不在圖裡，下面的框不可信（Box 一定會回一個框）' : ''}`);
    console.log(`外框（比例）left=${box.left} top=${box.top} right=${box.right} bottom=${box.bottom}  信心 ${pct(confidence)}`);
    console.log(`外框（像素，${images[0].orig ? '原圖' : '轉正後'} ${w}×${h}）x1=${px[0]} y1=${px[1]} x2=${px[2]} y2=${px[3]}  model=${r.model}`);
  } else {
    die(`不認得的指令 ${cmd}；可用 ask、choose、box`);
  }
}

main().catch((e) => die(e.message || String(e), 2));
