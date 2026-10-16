# Jev for Claude Code

An **unofficial** integration of [TypeSafe](https://typesafe.ai) **Jev**, a System One model that returns typed judgments with probabilities, into [Claude Code](https://claude.com/claude-code). One installer file covers Windows, WSL, Linux and macOS.

非官方的 Claude Code × TypeSafe Jev 整合。單一安裝檔，Windows／WSL／Linux／macOS 通用。

| Feature | What it does |
|---|---|
| **Skill suggestion** (`UserPromptSubmit` hook) | Ranks your installed skills against each prompt and suggests one only when it clearly fits. |
| **Task type** (same hook) | Classifies the request (bug fix, feature, review, security, Q&A…) and passes the result to Claude as context. |
| **Subagent model** (`PreToolUse: Agent\|Task`) | Picks the cheapest model tier that can do a subagent's job (full mode only). |
| **Shell risk gate** (`PreToolUse: Bash\|PowerShell`) | Asks you to confirm commands Jev judges destructive or secret-touching (full mode only). |
| **`/jev`** | `on`, `lite`, `off`, `status`, `test <text>`, `log [n]`. |
| **jev-vision** (CLI + skill) 🔥 | **Images + Box**: ask yes/no, pick-one, or *where is it* (bounding box) about PNG/JPEG files. Uses TypeSafe's experimental `TypeSafe-Danger-Zone-Images` feature. |

When Jev is unavailable (no key, API error, timeout), it warns once and Claude Code behaves exactly as before. Nothing ever falls back to a large model.

## Install with an agent (paste this into Claude Code)

```text
Install Jev for Claude Code by following
https://github.com/pachelbel23/claude-code-jev/blob/main/AGENT_INSTALL.md exactly.
Do not ask me to paste my API key into the chat.
```

## Install by hand

You need **Node.js 18+** and a TypeSafe API key from <https://console.typesafe.ai>.

```bash
# macOS / Linux / WSL
curl -fsSLO https://raw.githubusercontent.com/pachelbel23/claude-code-jev/main/setup-jev.mjs && node setup-jev.mjs
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/pachelbel23/claude-code-jev/main/setup-jev.mjs -OutFile setup-jev.mjs; node setup-jev.mjs
```

Options: `--mode lite|on|off` (default `lite`), `--key-file <file>`, `--no-gui`, `--key-only` (set or replace only the key).

Restart Claude Code afterwards.

### Modes 模式

- **`lite`** (default): skill suggestions and task type only. It never blocks commands or changes models.
- **`on`**: adds the subagent-model choice and the shell risk gate.
- **`off`**: Jev stays installed but does nothing.

Switch any time with `/jev lite`, `/jev on` or `/jev off`.

## Your API key stays out of sight 金鑰不外露

- **Entry**: the installer asks in a **password dialog**. Windows and WSL use a Windows dialog, macOS uses the native dialog, desktop Linux uses zenity or kdialog. Without a GUI it falls back to hidden terminal input, or you can pass `--key-file`.
- **Storage**: the key is saved to `~/.claude/jev/api_key`, readable only by you (icacls on Windows, `chmod 600` elsewhere). The `TYPESAFE_API_KEY` environment variable, if set, takes precedence.
- **Never exposed**: the key is never printed, logged, or written into `settings.json`, and the installer file contains no key.

## jev-vision: Images + Box

```bash
node ~/.claude/jev/jev-vision.mjs ask    photo.jpg "Is there a person at the door?"
node ~/.claude/jev/jev-vision.mjs choose shot.png "What kind of page is this?" login="A login form" dashboard="An admin dashboard" error="An error page"
node ~/.claude/jev/jev-vision.mjs box    device.jpg "the product label"
```

- **Box**: returns the edges as fractions of the image and in pixels, plus a confidence. It first asks whether the target is present at all, because a Box answer is always a box.
- **Image prep**: images outside 280–1568 px, or with EXIF rotation, are converted automatically. Windows/WSL use System.Drawing; elsewhere it uses ImageMagick, or `sips` on macOS.
- **For Claude**: a `jev-vision` skill tells Claude when it should use the tool, such as batch judgments over many files or precise crop boxes, and when it shouldn't, such as one-off looks or sensitive images.

> ⚠️ **Experimental.** TypeSafe labels images and Box *Dreamer-ready*, not production-ready. Treat the answers as suggestions. **Images are uploaded to TypeSafe**, so don't send anything you can't share.

## What gets installed

```
~/.claude/jev/jev.mjs            hooks + /jev
~/.claude/jev/jev-vision.mjs     Images + Box CLI
~/.claude/jev/config.json        thresholds (edit freely)
~/.claude/jev/install.mjs        adds the 4 hooks to settings.json (backs it up first)
~/.claude/jev/api_key            your key (owner-only)
~/.claude/skills/jev-vision/     skill for Claude
~/.claude/commands/jev.md        /jev fallback command
```

Re-running the installer is safe. Files that changed are backed up as `.bak-<time>`, and nothing is deleted.

**nvm and other per-shell Node installs**: on macOS, Linux and WSL, the hooks and `/jev` call Node by the absolute path of the `node` that ran the installer. Claude Code runs them in a non-interactive shell that never loads nvm, so a bare `node` would fail with `node: command not found`. If you later switch Node versions (for example `nvm use 22`), re-run `node ~/.claude/jev/install.mjs` with the new Node. It updates the paths in place. Windows keeps using `node` from PATH.

非 Windows 平台的 hooks 與 `/jev` 用安裝時那個 node 的絕對路徑（nvm 只在互動 shell 載入，Claude Code 的 hook 找不到）；之後換 node 版本請用新的 node 重跑 `node ~/.claude/jev/install.mjs`。

**Uninstall**: run `/jev off`, then remove the four `jev.mjs hook …` entries from `~/.claude/settings.json` (a backup from install time sits next to it) and delete the files above.

If `~/.claude/jev/jev.py` exists (another Jev implementation), the installer refuses to run so that hooks are not duplicated.

## Build from source

`src/` holds the sources. To regenerate the single-file installer:

```bash
node build.mjs --src src --out setup-jev.mjs
```

## License

MIT. Not affiliated with or endorsed by TypeSafe AI or Anthropic. "Jev" and "TypeSafe" are their owners' names, and the TypeSafe API is used under its own [terms](https://typesafe.ai/legal/terms).
