'use strict';
// Jobs that can be run from the shell or from inside a session: keys, models, doctor and update.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { c } = require('./theme');
const input = require('./input');
const { providers, VERSION } = require('./host');

const REPO = 'mailsitnc-ai/caelix-cli';
const ROOT = path.resolve(__dirname, '..', '..');
const say = (s = '') => process.stdout.write(s + '\n');
// everything piped in. With `patience`, stop waiting if nothing at all arrives (a pipe nobody closes).
function readStdin(patience) {
  return new Promise((resolve) => {
    const parts = []; let timer = null;
    const done = () => { clearTimeout(timer); process.stdin.pause(); resolve(Buffer.concat(parts).toString('utf8')); };
    if (patience) timer = setTimeout(done, patience);
    process.stdin.on('data', (d) => { clearTimeout(timer); parts.push(d); }); process.stdin.on('end', done); process.stdin.on('error', done); process.stdin.resume();
  });
}
const keyed = () => providers.PROVIDERS.filter((p) => !p.virtual);

function listKeys(host) {
  for (const p of keyed()) {
    const state = host.keys.has(p.id) ? c.sky(host.keys.masked(p.id)) : p.anonymous ? c.dim('works without a key') : c.dim('no key');
    say(`  ${p.id.padEnd(14)}${state}`);
  }
}

async function saveKey(host, id, value) {
  const key = String(value || '').trim();
  if (key.length < 4) throw new Error('That key looks too short; nothing was saved.');
  host.keys.set(id, key);
  say(c.green(`  Saved for ${id}: ${host.keys.masked(id)}`));
}

// caelix keys [list | add <provider> | remove <provider> | base <provider> <url>]
async function keysCommand(host, args, interactive = process.stdin.isTTY) {
  let [verb, id, url] = args;
  const need = () => { const p = keyed().find((x) => x.id === id); if (!p) throw new Error(`Unknown provider "${id || ''}". One of: ${keyed().map((x) => x.id).join(', ')}`); return p; };
  if (!verb && interactive) {
    const list = keyed();
    const n = await input.select('API keys: pick a provider', list.map((p) => ({ label: p.name, hint: host.keys.has(p.id) ? host.keys.masked(p.id) : p.anonymous ? 'works without a key' : 'no key' })), { filter: true });
    if (n < 0) return;
    id = list[n].id;
    const act = host.keys.has(id) ? await input.select(list[n].name, [{ label: 'Replace the key' }, { label: 'Remove the key' }]) : 0;
    if (act < 0) return;
    verb = act === 1 ? 'remove' : 'add';
  }
  if (!verb || verb === 'list') return listKeys(host);
  if (verb === 'add') {
    const p = need();
    if (url) throw new Error('Do not put the key on the command line (it would stay in your shell history). Run: caelix keys add ' + id);
    if (p.docs) say(c.dim('  Get a key at ' + p.docs));
    const value = interactive ? await input.ask(`Paste your ${p.name} key:`, { hidden: true }) : await readStdin();
    if (value === null) return say(c.dim('  Cancelled.'));
    return saveKey(host, id, value);
  }
  if (verb === 'remove') { need(); host.keys.remove(id); return say(c.dim(`  Removed the ${id} key.`)); }
  if (verb === 'base') {
    need(); const bases = host.bases();
    if (url) { if (!/^https?:\/\//.test(url)) throw new Error('The base URL must start with http:// or https://'); bases[id] = url; } else delete bases[id];
    host.saveState({ bases }); return say(c.dim(`  Base URL for ${id}: ${url || 'default'}`));
  }
  throw new Error('Use: caelix keys [list | add <provider> | remove <provider> | base <provider> <url>]');
}

async function modelsCommand(host, args) {
  const wanted = args[0] ? [args[0]] : host.connected();
  for (const id of wanted) {
    if (!providers.byId(id)) throw new Error('Unknown provider ' + id);
    say(c.bold(c.blue(providers.byId(id).name)));
    try { for (const m of await host.listModels(id)) say(`  ${id}/${m.id}${m.free ? c.dim('  free') : ''}`); } catch (e) { say(c.red('  ' + e.message)); }
  }
}

async function doctor(host) {
  const row = (ok, name, detail) => say(`  ${ok ? c.green('✔') : c.amber('!')} ${name.padEnd(16)}${c.dim(detail || '')}`);
  row(Number(process.versions.node.split('.')[0]) >= 22, 'Node', process.versions.node + ' (22 or newer)');
  row(true, 'CAELIX CLI', `${VERSION} at ${ROOT}`);
  let enc = false; try { const d = host.keys.backend(); const probe = '_doctor'; host.keys.set(probe, 'probe-value-1234'); enc = host.keys.get(probe) === 'probe-value-1234'; host.keys.remove(probe); row(enc, 'Key storage', `encrypted, master key in ${d === 'keychain' ? 'macOS Keychain' : d === 'dpapi' ? 'Windows DPAPI' : 'a private file'}`); } catch (e) { row(false, 'Key storage', e.message); }
  row(host.connected().length > 0, 'Providers', host.connected().join(', '));
  const browser = require('./browser').findBrowser();
  row(!!browser, 'Browser', browser || 'none found: looking at pages and PDF export are off');
  row(spawnSync('git', ['--version']).status === 0, 'git', '');
  row(true, 'Data folder', host.dir);
}

function update() {
  const git = fs.existsSync(path.join(ROOT, '.git'));
  const [cmd, args] = git ? ['git', ['-C', ROOT, 'pull', '--ff-only']] : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', 'github:' + REPO]];
  say(c.dim(`  ${cmd} ${args.join(' ')}`));
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  say(r.status === 0 ? c.green('  Done. Start caelix again to use the new version.') : c.red('  The update failed; the message above says why.'));
  return r.status === 0 ? 0 : 1;
}

module.exports = { readStdin, keysCommand, modelsCommand, doctor, update, REPO };
