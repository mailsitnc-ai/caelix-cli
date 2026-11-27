'use strict';
// Everything the engine needs from its host: folders, keys, settings, saved sessions and MCP servers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../engine/providers');
const config = require('../engine/config');
const agent = require('../engine/agent');
const { newRuntime } = require('../engine/runtime');
const { createSessionStore } = require('../engine/sessions');
const { connectAll } = require('../engine/mcp');
const { tasks, killTree } = require('../engine/tools');
const { createKeys } = require('./keystore');

const VERSION = require('../../package.json').version;

function createHost() {
  const dir = path.resolve(process.env.CAELIX_HOME || path.join(os.homedir(), '.caelix', 'cli'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  providers.setHealthFile(path.join(dir, 'model-health.json'));
  providers.setArchiveFile(path.join(dir, 'model-archive.json'));
  const keys = createKeys(dir);
  const store = createSessionStore(dir);
  const stateFile = path.join(dir, 'state.json');
  const readState = () => { const s = config.readJson(stateFile, {}); return { bases: {}, history: [], ...s }; };
  const saveState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }), { mode: 0o600 });
  const docsDir = process.env.CAELIX_DOCS || path.join(os.homedir(), 'Documents', 'CAELIX Chats');
  let mcp = null; let mcpKey = '';

  const host = {
    dir, keys, store, readState, saveState, docsDir,
    bases: () => readState().bases || {},
    connected: () => providers.PROVIDERS.filter((p) => !p.virtual && (keys.has(p.id) || p.anonymous)).map((p) => p.id),
    listModels: (pid, force) => providers.listModels(pid, keys.get(pid), host.bases(), { force }),
    defaultModel() { const s = readState(); return { provider: s.provider || 'omniroute', model: s.model || 'auto' }; },

    envFor(rt, { signal, emit, ask, allow = [], deny = [] }) {
      const settings = config.loadSettings(dir, rt.st.cwd);
      settings.permissions.allow.push(...allow); settings.permissions.deny.push(...deny);
      return {
        userDir: dir, settings, signal, emit, ask, docsDir,
        getCreds: (pid) => ({ key: keys.get(pid), base: host.bases()[pid] || '' }),
        connected: host.connected, bases: host.bases,
        renderDocument: async (file, content, fmt) => {
          const { createRenderer } = require('./markdown');
          const { plain } = require('./theme');
          const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const md = createRenderer();
          const html = /<html|<!doctype/i.test(content) ? content : `<!doctype html><meta charset="utf-8"><body style="font:14px/1.6 sans-serif;max-width:760px;margin:36px auto;white-space:pre-wrap">${esc(content.split('\n').map((l) => plain(md.line(l))).join('\n'))}`;
          if (fmt === 'html') { fs.writeFileSync(file, html); return file; }
          return require('./browser').renderPdf(file, html);
        },
      };
    },

    async connectMcp(rt, env) {
      const key = rt.st.cwd + '|' + JSON.stringify(env.settings.mcpServers) + JSON.stringify(env.settings.builtinOff);
      if (!mcp || key !== mcpKey) { if (mcp) mcp.stop(); mcp = await connectAll(env.settings.mcpServers, rt.st.cwd, { userDir: dir, disabled: env.settings.builtinOff }); mcpKey = key; }
      rt.mcp = mcp; return mcp;
    },

    newSession({ provider, model, cwd, mode, kind, effort }) {
      const def = host.defaultModel();
      const rt = newRuntime({ provider: provider || def.provider, model: model || def.model, cwd, mode: mode || 'default', kind });
      rt.effort = effort || 'medium';
      const now = Date.now();
      return { rt, meta: { id: store.newId(), title: 'New session', created: now, updated: now } };
    },
    load(id) {
      const s = store.load(id); if (!s) return null;
      const rt = newRuntime({ provider: s.provider, model: s.model, cwd: fs.existsSync(s.cwd) ? s.cwd : process.cwd(), mode: s.mode, kind: s.kind, messages: s.messages || [], checkpoints: (s.checkpoints || []).map((x) => ({ ...x, snap: new Map(x.snap) })) });
      Object.assign(rt, { baseSnap: new Map(s.baseSnap || []), turn: s.turn || 0, usage: s.usage || { in: 0, out: 0 }, effort: s.effort || 'medium', summary: s.summary || '', team: !!s.team, coder: s.coder || null, reviewer: s.reviewer || null });
      rt.st.todos = s.todos || [];
      return { rt, meta: { id: s.id, title: s.title, created: s.created, updated: s.updated } };
    },
    save({ rt, meta }) {
      if (!rt.messages.length) return;
      meta.updated = Date.now();
      store.save({
        ...meta, kind: rt.kind, provider: rt.provider, model: rt.model, mode: rt.st.mode, cwd: rt.st.cwd, effort: rt.effort, messages: rt.messages, usage: rt.usage, turn: rt.turn, summary: rt.summary || '', team: !!rt.team, coder: rt.coder, reviewer: rt.reviewer, todos: rt.st.todos,
        checkpoints: rt.checkpoints.map((x) => ({ turn: x.turn, msgIndex: x.msgIndex, prompt: x.prompt, snap: Array.from(x.snap) })), baseSnap: Array.from(rt.baseSnap),
      });
    },
    sessions: (cwd) => store.list().filter((s) => !cwd || s.cwd === cwd),

    close() { if (mcp) mcp.stop(); mcp = null; for (const t of tasks.values()) if (t.status === 'running') { killTree(t.child); } },
  };
  return host;
}

// "@path" in a message attaches that file (or picture)
function expandMentions(text, cwd) {
  const parts = []; const images = []; const seen = new Set();
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g)) {
    const raw = (m[1] || m[2]).replace(/[),.;:]+$/, '');
    const f = path.resolve(cwd, raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
    if (seen.has(f)) continue; seen.add(f);
    let st; try { st = fs.statSync(f); } catch (_) { continue; }
    const img = /\.(png|jpe?g|webp|gif)$/i.exec(f);
    if (st.isDirectory()) parts.push(`Folder ${raw}:\n${fs.readdirSync(f).slice(0, 200).join('\n')}`);
    else if (img && st.size < 5e6) images.push(`data:image/${img[1].toLowerCase().replace('jpg', 'jpeg')};base64,${fs.readFileSync(f).toString('base64')}`);
    else if (!img && st.size < 2e6) { const body = fs.readFileSync(f, 'utf8'); if (!body.includes('\0')) parts.push(`Contents of ${raw}:\n\`\`\`\n${body.slice(0, 40000)}${body.length > 40000 ? '\n[truncated]' : ''}\n\`\`\``); }
  }
  return { text: parts.length ? text + '\n\n' + parts.join('\n\n') : text, images, attached: parts.length + images.length };
}

module.exports = { createHost, expandMentions, VERSION, agent, providers, config };
