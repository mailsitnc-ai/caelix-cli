# ✦ CAELIX CLI

A coding agent in your terminal. It reads and edits files, runs commands, searches the web and checks its own work, using whichever model provider you choose. It shares its engine with the [CAELIX desktop app](https://github.com/mailsitnc-ai/caelix-v2).

No build step and no dependencies. It needs **Node 22 or newer**.

## Install

```bash
npm install -g github:mailsitnc-ai/caelix-cli
```

Then, inside a project folder:

```bash
caelix
```

With no key at all, automatic routing tries the free models on Kilo Gateway and OpenCode Zen. Free models are rate limited and vary in quality. Add a key for better ones:

```bash
caelix keys add openrouter
```

## Using it

```bash
caelix                              # interactive session in this folder
caelix "explain this project"       # start with a message
caelix -p "what does main.js do?"   # answer once and exit
git diff | caelix -p "review this"  # pipe input in
caelix -c                           # continue the last session here
caelix -r                           # pick an earlier session
```

In a session:

| Key or prefix | What it does |
| --- | --- |
| `shift+tab` | cycle Manual, Accept edits, Plan, Auto |
| `esc` | interrupt the running turn |
| `ctrl+c` twice | leave |
| `\` + enter, or option+enter | new line |
| `@path` | attach a file or picture (tab completes) |
| `!command` | run a shell command yourself |
| `# note` | save a note about this project |

Commands: `/help /model /test /team /keys /mode /plan /chat /code /clear /resume /rename /compact /reset /context /diff /rewind /init /memory /remember /effort /mcp /hooks /export /copy /doctor /update /exit`.

### One-shot mode

`-p` never asks questions. Reading is allowed; anything that changes files or runs commands needs permission up front:

```bash
caelix -p --mode acceptEdits --allowed-tools "Bash(npm test)" "fix the failing test"
```

`--output-format json` or `stream-json` gives machine-readable output.

## Team mode

One model writes the code and a second one reviews the files it edited. If the reviewer asks for changes, the coder makes them (one round).

```bash
caelix team                       # menu: choose coder and reviewer, turn on or off
caelix team set kilo/kilo-auto/free openrouter/some/model
caelix team off
```

In a session use `/team`. The choice is remembered. For one run, use `--team`, `--no-team`, `--coder provider/model` or `--reviewer provider/model`. The reviewer only runs when files were written or edited with the file tools, not when a shell command changed them.

## Checking and testing models

```bash
caelix models kilo                       # list what a provider offers
caelix test kilo                         # send each a real message, and check it can use tools
caelix test openrouter --free --match qwen
caelix test groq/some-model openrouter/other/model
caelix test                              # your current and team models
```

A provider is tested 25 models at a time; use `--limit n` or `--all` for more, and `--no-tools` to skip the tool check. With no key for a provider, only its free models are tested. Each test is a real request, so it counts against your limits. In a session, `/test kilo` does the same and offers to switch to a model that works.

## What it can do

- **Tools:** read, write, edit, search files, shell (with background tasks), web search and fetch, task list, sub-agents, plan mode, documents (md, txt, html, pdf).
- **Permissions:** five modes plus allow and deny rules. Destructive-looking commands are held back.
- **Seeing without a vision model:** it can open a page it built in a headless Chrome, Edge or Brave, collect console errors and layout problems, and read the screenshot with on-device OCR.
- **Staying on track:** it keeps going past a failed step, says why a turn ended, and cuts off replies that loop or invent tool output.
- **Team mode:** a coder and a reviewer (see above).
- **Checkpoints:** `/rewind` restores files and conversation.
- **Extensible:** MCP servers, hooks, skills (`.caelix/skills/<name>/SKILL.md`), your own commands (`.caelix/commands/<name>.md`, `$ARGUMENTS` is replaced), and project instructions in `CAELIX.md` or `AGENTS.md`.

## Providers

Google Gemini, OpenRouter, NVIDIA NIM, Groq, CoArena, Kilo Gateway, OpenCode Zen, AxForge, Runcrate, Z.ai, Numes, Abliteration AI, and OmniRoute (automatic routing with fallback). `caelix models` lists what is available.

## Keys and data

Keys are encrypted with AES-256-GCM. The master key is kept in the macOS Keychain, in Windows DPAPI, or on Linux in a file only your user can read. Keys are shown only by their last 4 characters and cannot be passed on the command line. `CAELIX_<PROVIDER>_API_KEY` environment variables also work.

Sessions and settings live in `~/.caelix/cli`. The desktop app keeps its own keys and chats; the two are not shared.

What you type, and the files the agent reads, are sent to the model provider you use.

## Status

The self-check runs on macOS with a scripted model: one-shot mode, permissions, key storage, page viewing and the interactive terminal. **Windows and Linux are untested**, and the shell tool expects a POSIX shell, so on Windows use WSL.

```bash
npm run selfcheck
```

`caelix doctor` checks your installation. `caelix update` gets the newest version.

## Licence

MIT
