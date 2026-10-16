# AGENT_INSTALL: instructions for an AI coding agent

You are installing **Jev for Claude Code** (hooks plus the jev-vision Images/Box tool) on the user's machine. Follow these steps in order, and explain each step to the user before you run it.

## Hard rules

1. **Never handle the API key yourself.** Do not ask the user to paste it into the chat. Do not read, print, `cat` or copy `~/.claude/jev/api_key`. Do not put the key in `settings.json`, in shell rc files, or in any command line. The installer collects the key itself through a password dialog or hidden input.
2. **Do not delete anything.** The installer only adds files and backs up the ones it changes.
3. If any check below fails, **stop and tell the user**. Don't improvise a workaround.

## Steps

1. **Check Node.js 18 or newer.** Run `node --version`. If it is missing or older, stop and ask the user to install Node.js 18+ first.

2. **Check for another Jev implementation.** If `~/.claude/jev/jev.py` exists, stop. This machine already runs a different Jev, and installing this one would duplicate hooks.

3. **Download the installer** into a new, empty temporary directory:
   - **macOS / Linux / WSL:**
     `mkdir -p /tmp/jev-install && cd /tmp/jev-install && curl -fsSLO https://raw.githubusercontent.com/pachelbel23/claude-code-jev/main/setup-jev.mjs`
   - **Windows (PowerShell):**
     `$d = New-Item -ItemType Directory -Force "$env:TEMP\jev-install"; Invoke-WebRequest https://raw.githubusercontent.com/pachelbel23/claude-code-jev/main/setup-jev.mjs -OutFile "$d\setup-jev.mjs"`

   Tell the user the installer is a single readable JavaScript file and that they can review it before you run it.

4. **Run the installer.** Use `node setup-jev.mjs`; the default mode is `lite`. Add `--mode on` only if the user asked for the shell risk gate and subagent model choice.
   - **Before running, tell the user**: "A password dialog titled **Jev - TypeSafe API Key** will appear. Paste your TypeSafe API key there, not in this chat."
   - **No GUI**: in an SSH session, a headless box, or a sandbox without a display, the installer prints `No terminal for input`. That's expected. Finish the remaining steps, then tell the user to run this in **their own terminal**, not through you:
     `node <path-to>/setup-jev.mjs --key-only`

5. **Verify** with these commands (neither prints the key):
   - `node ~/.claude/jev/jev.mjs cli status`: should show the mode and `金鑰 TYPESAFE_API_KEY：已設定` (key is set).
   - `node ~/.claude/jev/jev-vision.mjs help`: should print the jev-vision usage.

6. **Finish.** Tell the user to **restart Claude Code** so it loads the hooks and the `jev-vision` skill. Also tell them:
   - `/jev status`, `/jev lite`, `/jev on` and `/jev off` control Jev.
   - jev-vision (Images + Box) is **experimental**, and the images it analyzes are **uploaded to TypeSafe**.
