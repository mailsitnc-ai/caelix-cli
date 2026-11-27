'use strict';
// The interactive session: prompt, turns, permission questions and slash commands.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { c, clean, banner, fit, cols } = require('./theme');
const input = require('./input');
const { createView, diffText, title } = require('./render');
const { createRenderer } = require('./markdown');
const { expandMentions, VERSION, agent, providers, config } = require('./host');
const { MODE_LABEL } = require('../engine/permissions');
const { keysCommand, doctor, update } = require('./tasks');

const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
const textOf = (content) => agent.textOf(content).split('\n\n[CAELIX note')[0];

async function startRepl(host, opts) {
  let session; let abort = null; let quit = false; let shellNotes = [];
  const fresh = (extra = {}) => host.newSession({ provider: opts.provider, model: opts.model, cwd: process.cwd(), mode: opts.mode, kind: opts.chat ? 'chat' : 'code', effort: opts.effort, ...extra });
  const rt = () => session.rt;
  const view = createView({ cwd: () => rt().st.cwd });
  const say = (s = '') => view.out(s);
  const dim = (s) => say(c.dim('  ' + s));
  const modelName = () => `${rt().provider} / ${rt().model}`;
  const showBanner = () => say(banner({ version: VERSION, model: modelName(), cwd: rt().st.cwd.replace(os.homedir(), '~'), mode: MODE_LABEL[rt().st.mode], kind: rt().kind }));

  function replay() {
    const shown = rt().messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !textOf(m.content).startsWith('[CAELIX reminder]')).slice(-6);
    for (const m of shown) {
      const md = createRenderer();
      const lines = textOf(m.content).split('\n').slice(0, 12);
      say(); lines.forEach((l, i) => say(m.role === 'user' ? (i ? '  ' : c.blue('› ')) + c.bold(clean(l)) : (i ? '  ' : c.blue('✦ ')) + md.line(l)));
    }
    if (shown.length) dim(`resumed “${session.meta.title}”`);
  }

  async function ask(req) {
    view.pause();
    try {
      if (req.kind === 'permission') {
        const i = req.input || {};
        say(); say(c.badge(title(req.tool) + ' needs your OK'));
        if (req.tool === 'Bash') say('  ' + c.ice(clean(i.command).split('\n').join('\n  ')) + (i.description ? '\n  ' + c.dim(clean(i.description)) : ''));
        else if (req.tool === 'Write' || req.tool === 'Edit') {
          const f = path.resolve(rt().st.cwd, i.file_path || ''); let before = ''; try { before = fs.readFileSync(f, 'utf8'); } catch (_) {}
          const after = req.tool === 'Write' ? String(i.content || '') : before.split(i.old_string || '\0').join(i.new_string || '');
          say('  ' + c.ice(f)); say(diffText(before, after).text);
        } else say('  ' + c.ice(fit(clean(req.summary), cols() * 3)));
        const n = await input.select('Allow it?', [{ label: 'Yes' }, { label: `Yes, and don't ask again for ${req.rule}`, hint: 'saved for this project' }, { label: 'No, and say what to do instead', hint: 'esc' }]);
        if (n === 0) return { decision: 'once' };
        if (n === 1) return { decision: 'always' };
        const why = n === 2 ? await input.ask('What should it do instead?') : '';
        return { decision: 'deny', comment: why || '' };
      }
      if (req.kind === 'question') {
        say(); const options = (req.options || []).map((o) => ({ label: String(o) }));
        const n = await input.select(clean(req.question), [...options, { label: 'Type my own answer' }]);
        const answer = n >= 0 && n < options.length ? options[n].label : (await input.ask('Your answer:')) || 'No answer given.';
        dim('answered: ' + answer); return answer;
      }
      if (req.kind === 'plan') {
        const md = createRenderer(); say(); say(c.badge('Plan'));
        for (const l of String(req.plan).split('\n')) say('  ' + md.line(l));
        const n = await input.select('Go ahead with this plan?', [{ label: 'Yes, carry it out' }, { label: 'No, keep planning' }]);
        if (n === 0) return 'approve';
        return (await input.ask('What should change?')) || 'Keep planning.';
      }
      return 'deny';
    } finally { view.resume(); }
  }

  const envFor = (emit) => host.envFor(rt(), { signal: abort.signal, emit: emit || ((e) => view.event(e)), ask, allow: opts.allow, deny: opts.deny });

  // run something that talks to the model, interruptible with esc or ctrl+c
  async function busy(fn) {
    abort = new AbortController();
    const off = input.listen((_s, key) => { if (key.name === 'escape' || (key.ctrl && key.name === 'c')) abort.abort(); });
    view.begin();
    try { return await fn(envFor()); } catch (e) { view.event({ type: 'error', message: e.message }); } finally { view.end(); off(); }
  }

  async function turn(raw) {
    const { text, images, attached } = expandMentions(raw, rt().st.cwd);
    if (attached) dim(`attached ${attached} item(s)`);
    const full = shellNotes.length ? `${text}\n\nCommands I ran myself:\n${shellNotes.join('\n\n')}` : text; shellNotes = [];
    if (session.meta.title === 'New session') session.meta.title = agent.fallbackTitle(raw);
    await busy(async (env) => { await host.connectMcp(rt(), env); for (const e of rt().mcp.errors) view.notice('MCP: ' + e, c.amber); await agent.runTurn(rt(), env, full, images); });
    host.save(session);
  }

  // ---------- models ----------
  async function pickModel(heading = 'Choose a provider') {
    const list = providers.PROVIDERS.filter((p) => !p.hidden);
    const ready = (p) => p.virtual || p.anonymous || host.keys.has(p.id);
    const sorted = [...list].sort((a, b) => ready(b) - ready(a));
    const pi = await input.select(heading, sorted.map((p) => ({ label: p.name, hint: ready(p) ? (host.keys.has(p.id) ? 'key saved' : 'ready') : 'needs a key: /keys' })), { filter: true });
    if (pi < 0) return null;
    const p = sorted[pi]; let models;
    dim('loading models…');
    try { models = await host.listModels(p.id); } catch (e) { say(c.red('  ' + e.message)); return null; }
    if (!models.length) { dim('That provider lists no models.'); return null; }
    models = [...models].sort((a, b) => !!b.free - !!a.free);
    const mi = await input.select(`${p.name}: choose a model (type to filter)`, models.map((m) => ({ label: m.id, hint: [m.free ? 'free' : '', m.desc || ''].filter(Boolean).join(' · ') })), { filter: true });
    return mi < 0 ? null : { provider: p.id, model: models[mi].id };
  }
  function setModel(sel) { rt().provider = sel.provider; rt().model = sel.model; host.saveState({ provider: sel.provider, model: sel.model }); dim('Now using ' + modelName()); }
  function setMode(mode) { rt().st.mode = mode; dim('Mode: ' + MODE_LABEL[mode]); }

  // ---------- commands ----------
  const commands = {
    help: ['show commands', () => {
      say(); for (const [n, [hint]] of Object.entries(commands)) say('  ' + c.sky(('/' + n).padEnd(12)) + c.dim(hint));
      say(); dim('!command runs a shell command · # note saves it to memory · @file attaches a file');
      dim('shift+tab changes mode · end a line with \\ (or option+enter) for a new line · esc interrupts');
    }],
    model: ['choose provider and model (/model provider/model)', async (arg) => {
      if (!arg) { const s = await pickModel(); if (s) setModel(s); return; }
      const [head, ...rest] = arg.split('/');
      setModel(providers.byId(head) && rest.length ? { provider: head, model: rest.join('/') } : { provider: rt().provider, model: arg });
    }],
    keys: ['add or remove API keys', async () => { await keysCommand(host, [], true); }],
    mode: ['change permission mode', async (arg) => {
      const all = Object.keys(MODE_LABEL);
      if (all.includes(arg)) return setMode(arg);
      const n = await input.select('Permission mode', all.map((m) => ({ label: MODE_LABEL[m], hint: m })), { start: all.indexOf(rt().st.mode) });
      if (n >= 0) setMode(all[n]);
    }],
    plan: ['plan first, change nothing', () => setMode('plan')],
    chat: ['new chat with no project tools', () => { host.save(session); session = fresh({ kind: 'chat' }); showBanner(); }],
    code: ['new coding session in this folder', () => { host.save(session); session = fresh({ kind: 'code' }); showBanner(); }],
    clear: ['start a new session', () => { host.save(session); session = fresh({ kind: rt().kind, provider: rt().provider, model: rt().model, mode: rt().st.mode }); process.stdout.write('\x1b[2J\x1b[H'); showBanner(); }],
    resume: ['reopen an earlier session', async () => {
      const list = host.sessions(rt().st.cwd).filter((s) => s.id !== session.meta.id).slice(0, 40);
      if (!list.length) return dim('No earlier sessions in this folder.');
      const n = await input.select('Resume which session?', list.map((s) => ({ label: s.title, hint: ago(s.updated) })), { filter: true });
      if (n < 0) return; host.save(session); session = host.load(list[n].id); replay();
    }],
    rename: ['name this session', (arg) => { if (!arg) return dim('Usage: /rename <name>'); session.meta.title = arg.slice(0, 120); host.save(session); dim('Renamed.'); }],
    compact: ['summarise older messages', async () => { const ok = await busy((env) => agent.compact(rt(), env, 'compact')); if (ok === false) dim('Nothing to compact yet.'); host.save(session); }],
    reset: ['summarise everything and free the context', async () => { await busy((env) => agent.resetContext(rt(), env, 'manual')); host.save(session); }],
    context: ['show context and token use', () => {
      const b = agent.breakdown(rt().messages);
      dim(`context about ${b.total} tokens (system ${b.system}, messages ${b.messages}, tools ${b.tools})`);
      dim(`used this session: ${rt().usage.in} in, ${rt().usage.out} out`);
    }],
    diff: ['files changed this session', () => {
      let any = false;
      for (const [f, before] of rt().baseSnap) {
        let now = ''; try { now = fs.readFileSync(f, 'utf8'); } catch (_) {}
        if (now === (before || '')) continue; any = true;
        const d = diffText(before || '', now, 40); say(c.bold(f) + '  ' + c.green('+' + d.add) + ' ' + c.red('-' + d.del)); say(d.text);
      }
      if (!any) dim('No file changes.');
    }],
    rewind: ['undo to before an earlier message', async () => {
      const cps = [...rt().checkpoints].reverse(); if (!cps.length) return dim('Nothing to rewind.');
      const n = await input.select('Rewind to before which message?', cps.map((x) => ({ label: x.prompt, hint: 'turn ' + x.turn }))); if (n < 0) return;
      const what = await input.select('Restore what?', [{ label: 'Files and conversation' }, { label: 'Conversation only' }, { label: 'Files only' }]); if (what < 0) return;
      const r = agent.rewind(rt(), cps[n].turn, { code: what !== 1, conversation: what !== 2 });
      dim(r.ok ? `Rewound. ${r.restored.length} file(s) restored.` : r.error); host.save(session);
    }],
    init: ['write a CAELIX.md for this project', () => turn('Look through this project and write a short CAELIX.md at its root: what it is, how to run and test it, how the code is laid out, and conventions to follow. Only state what the files show.')],
    memory: ['show loaded instructions and memory', () => say(clean(config.loadMemory(host.dir, rt().st.cwd) || '(none yet: add CAELIX.md or AGENTS.md to the project, or type # followed by a note)'))],
    remember: ['save a note for this project', (arg) => { if (!arg) return dim('Usage: /remember <note>'); dim('Saved to ' + config.addNote(host.dir, rt().st.cwd, arg)); }],
    effort: ['low, medium or high', (arg) => { if (['low', 'medium', 'high'].includes(arg)) rt().effort = arg; dim('Effort: ' + rt().effort); }],
    team: ['a coder model plus a reviewer model (/team off)', async (arg) => {
      if (arg === 'off') { rt().team = false; return dim('Team mode off.'); }
      const coder = await pickModel('Team: provider for the CODER'); if (!coder) return;
      const reviewer = await pickModel('Team: provider for the REVIEWER'); if (!reviewer) return;
      Object.assign(rt(), { team: true, coder, reviewer }); dim(`Team on. Coder ${coder.provider}/${coder.model}, reviewer ${reviewer.provider}/${reviewer.model}`);
    }],
    mcp: ['list, add or remove MCP servers', async (arg) => {
      const [verb, name, ...cmd] = arg.split(' ');
      try {
        if (verb === 'add') { config.addMcp(host.dir, rt().st.cwd, { name, scope: 'user', command: cmd.join(' ') }); return dim('Added ' + name); }
        if (verb === 'remove') { config.removeMcp(host.dir, rt().st.cwd, name, 'user'); return dim('Removed ' + name); }
      } catch (e) { return say(c.red('  ' + e.message)); }
      abort = new AbortController(); const m = await host.connectMcp(rt(), envFor());
      for (const s of m.servers) dim(`${s.name}  ${s.tools.length} tools${s.builtin ? ' (built in)' : ''}`);
      for (const e of m.errors) say(c.amber('  ' + e));
      dim('/mcp add <name> <command or URL> · /mcp remove <name>');
    }],
    hooks: ['list hooks', () => { const h = config.listHooks(host.dir, rt().st.cwd); if (!h.length) return dim(`No hooks. Add them to ${path.join(host.dir, 'hooks.json')} or .caelix/hooks.json`); for (const x of h) dim(`${x.event} ${x.matcher} → ${x.command}${x.enabled === false ? ' (off)' : ''}`); }],
    export: ['save this conversation as Markdown', (arg) => {
      const f = path.resolve(rt().st.cwd, arg || 'caelix-conversation.md');
      if (fs.existsSync(f)) return dim(f + ' already exists; give another name.');
      fs.writeFileSync(f, rt().messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => `## ${m.role === 'user' ? 'You' : 'CAELIX'}\n\n${textOf(m.content)}`).join('\n\n') + '\n'); dim('Saved ' + f);
    }],
    copy: ['copy the last reply', () => {
      const last = [...rt().messages].reverse().find((m) => m.role === 'assistant' && m.content); if (!last) return dim('Nothing to copy.');
      const [cmd, args] = process.platform === 'darwin' ? ['pbcopy', []] : process.platform === 'win32' ? ['clip', []] : ['xclip', ['-selection', 'clipboard']];
      const r = spawnSync(cmd, args, { input: textOf(last.content) }); dim(r.status === 0 ? 'Copied.' : 'Could not reach the clipboard.');
    }],
    doctor: ['check this installation', async () => { await doctor(host); }],
    update: ['get the newest CAELIX CLI', () => { update(); }],
    exit: ['leave', () => { quit = true; }],
  };
  commands.quit = ['leave', commands.exit[1]];

  const customDirs = () => [path.join(rt().st.cwd, '.caelix', 'commands'), path.join(os.homedir(), '.caelix', 'commands')];
  function customCommands() {
    const out = new Map();
    for (const d of customDirs()) { try { for (const f of fs.readdirSync(d)) if (f.endsWith('.md') && !out.has(f.slice(0, -3))) out.set(f.slice(0, -3), path.join(d, f)); } catch (_) {} }
    return out;
  }

  function suggest(buf, cur) {
    if (/^\/[\w-]*$/.test(buf)) {
      const all = [...Object.entries(commands).filter(([n]) => n !== 'quit').map(([n, [hint]]) => [n, hint]), ...[...customCommands().keys()].map((n) => [n, 'custom command'])];
      return all.filter(([n]) => ('/' + n).startsWith(buf) && '/' + n !== buf).map(([n, hint]) => ({ label: '/' + n, hint, value: '/' + n + ' ' }));
    }
    const m = /(^|\s)@([^\s"]*)$/.exec(buf.slice(0, cur)); if (!m) return [];
    const typed = m[2]; const slash = typed.lastIndexOf('/'); const dir = typed.slice(0, slash + 1); const stem = typed.slice(slash + 1).toLowerCase();
    let entries = []; try { entries = fs.readdirSync(path.resolve(rt().st.cwd, dir || '.'), { withFileTypes: true }); } catch (_) {}
    return entries.filter((e) => e.name.toLowerCase().startsWith(stem) && (stem.startsWith('.') || !e.name.startsWith('.')) && e.name !== 'node_modules').slice(0, 20).map((e) => {
      const p = dir + e.name + (e.isDirectory() ? '/' : '');
      const head = buf.slice(0, cur - typed.length);
      return { label: '@' + p, hint: '', value: head + p + buf.slice(cur), cursor: head.length + p.length };
    }).filter((s) => s.value !== buf);
  }

  async function handle(line) {
    const text = line.trim(); if (!text) return;
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim(); if (!cmd) return;
      const r = spawnSync(cmd, { shell: true, cwd: rt().st.cwd, encoding: 'utf8', maxBuffer: 1e7, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = clean((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).trimEnd();
      say(c.dim(out || '(no output)')); shellNotes.push(`$ ${cmd}\n${out.slice(0, 4000)}`); return;
    }
    if (text.startsWith('#') && !text.includes('\n')) { if (text.slice(1).trim()) dim('Saved to ' + config.addNote(host.dir, rt().st.cwd, text.slice(1).trim())); return; }
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (m) {
      const [, name, arg = ''] = m;
      if (commands[name]) return commands[name][1](arg.trim());
      if (name === 'cost' || name === 'usage' || name === 'status') { dim(modelName() + ' · ' + MODE_LABEL[rt().st.mode]); return commands.context[1](''); }
      const custom = customCommands().get(name);
      if (custom) return turn(fs.readFileSync(custom, 'utf8').split('$ARGUMENTS').join(arg));
      return dim(`Unknown command /${name}. Try /help.`);
    }
    return turn(line);
  }

  // ---------- start ----------
  if (opts.resume !== undefined || opts.continue) {
    let id = typeof opts.resume === 'string' ? opts.resume : '';
    const list = host.sessions(process.cwd());
    if (!id && opts.continue) id = list[0] && list[0].id;
    if (!id && opts.resume === true && list.length) { const n = await input.select('Resume which session?', list.slice(0, 40).map((s) => ({ label: s.title, hint: ago(s.updated) })), { filter: true }); if (n >= 0) id = list[n].id; }
    session = id ? host.load(id) : null;
    if (session) { if (opts.model) session.rt.model = opts.model; if (opts.provider) session.rt.provider = opts.provider; if (opts.mode) session.rt.st.mode = opts.mode; }
  }
  const resumed = !!session; if (!session) session = fresh();
  showBanner();
  if (resumed) replay();
  else if (opts.resume !== undefined || opts.continue) dim('No earlier session found here, so this is a new one.');
  if (!host.keys.has(rt().provider) && !providers.byId(rt().provider)?.keyOptional) dim(`No key for ${rt().provider} yet: type /keys`);
  if (opts.prompt) { say(c.blue('› ') + c.bold(clean(opts.prompt))); await handle(opts.prompt); }

  const history = host.readState().history || [];
  while (!quit) {
    say();
    const line = await input.prompt({
      history, suggest,
      footer: () => {
        const m = rt().st.mode; const tint = m === 'bypassPermissions' ? c.red : m === 'plan' ? c.amber : c.blue;
        return tint('● ' + MODE_LABEL[m]) + c.dim(fit(` · ${modelName()}${rt().kind === 'chat' ? ' · chat' : ''}${rt().team ? ' · team' : ''}`, cols() - 24));
      },
      onShiftTab: () => { if (rt().kind === 'code') rt().st.mode = CYCLE[(CYCLE.indexOf(rt().st.mode) + 1) % CYCLE.length]; },
    });
    if (line === null) break;
    if (history[history.length - 1] !== line && line.length < 4000) { history.push(line); history.splice(0, history.length - 200); host.saveState({ history }); }
    try { await handle(line); } catch (e) { say(c.red('✖ ' + e.message)); }
  }
  host.save(session);
  if (session.rt.messages.length) dim('Session saved. Continue it with: caelix --continue');
  input.stop();
}

module.exports = { startRepl };
