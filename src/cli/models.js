'use strict';
// Choosing models, and checking that they really answer and can use tools.
const { c, fit, cols, clean } = require('./theme');
const input = require('./input');
const providers = require('../engine/providers');

// "provider/model" -> {provider, model}. Model names may contain slashes themselves.
function parseSpec(text, fallbackProvider) {
  const [head, ...rest] = String(text || '').split('/');
  if (providers.byId(head) && rest.length) return { provider: head, model: rest.join('/') };
  if (fallbackProvider && text && !providers.byId(text)) return { provider: fallbackProvider, model: text };
  throw new Error(`Write the model as provider/model, for example kilo/${'kilo-auto/free'} (got "${text || ''}").`);
}
const specName = (s) => (s ? `${s.provider}/${s.model}` : '(not set)');

const usable = (host, id) => { const p = providers.byId(id); return !!p && (p.virtual || p.anonymous || host.keys.has(id)); };

// provider menu, then model menu. Returns {provider, model} or null.
async function pickModel(host, heading = 'Choose a provider', say = (s) => process.stdout.write(s + '\n')) {
  const list = providers.PROVIDERS.filter((p) => !p.hidden).sort((a, b) => usable(host, b.id) - usable(host, a.id));
  const pi = await input.select(heading, list.map((p) => ({ label: p.name, hint: usable(host, p.id) ? (host.keys.has(p.id) ? 'key saved' : 'ready') : 'needs a key: /keys' })), { filter: true });
  if (pi < 0) return null;
  const p = list[pi]; let models;
  say(c.dim('  loading models…'));
  try { models = await host.listModels(p.id); } catch (e) { say(c.red('  ' + e.message)); return null; }
  if (!models.length) { say(c.dim('  That provider lists no models.')); return null; }
  models = [...models].sort((a, b) => !!b.free - !!a.free);
  const mi = await input.select(`${p.name}: choose a model (type to filter)`, models.map((m) => ({ label: m.id, hint: [m.free ? 'free' : '', m.desc || ''].filter(Boolean).join(' · ') })), { filter: true });
  return mi < 0 ? null : { provider: p.id, model: models[mi].id };
}

const PROBE_TOOL = [{ type: 'function', function: { name: 'report_number', description: 'Report a number to the user.', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } }];

function why(e, keyless) {
  const s = e.status;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'no answer in time';
  if (keyless && [401, 402, 403].includes(s)) return 'needs your own key (paid model)';
  if (s === 401 || s === 403) return 'no access (check the key)';
  if (s === 402) return 'needs credits';
  if (s === 404) return 'not found for this account';
  if (s === 429) return 'rate limited (try again later)';
  if (s === 400 || s === 422) return 'request refused';
  return s ? 'error ' + s : 'could not connect';
}

// Send a real message (and, if asked, a tool request) to one model.
async function testModel(host, { provider, model }, { tools = true, timeout = 60000, signal } = {}) {
  const row = { provider, model, ok: false, tools: null, ms: 0, verdict: '', detail: '' };
  if (provider === 'omniroute' && !host.bases().omniroute) { row.verdict = 'automatic routing: test the real providers instead'; return row; }
  if (!usable(host, provider)) { row.verdict = `no key saved (caelix keys add ${provider})`; return row; }
  const key = host.keys.get(provider); const base = host.bases()[provider];
  const call = (content, defs) => providers.streamChat({ provider, key, base, model, messages: [{ role: 'user', content }], tools: defs, maxTokens: 1024, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const t0 = Date.now();
  try {
    const r = await call('Reply with the single word: ready', null);
    row.ms = Date.now() - t0;
    if (!String(r.text || '').trim()) { row.verdict = 'replied with nothing'; return row; }
    row.ok = true; row.verdict = 'works'; row.detail = String(r.text).trim().replace(/\s+/g, ' ').slice(0, 60);
    providers.markOk(provider, model);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    row.ms = Date.now() - t0; row.verdict = why(e, !key); row.detail = String(e.message).replace(/\s+/g, ' ').slice(0, 200);
    if ([400, 401, 402, 403, 404, 422].includes(e.status)) providers.markFailed(provider, model, e);
    return row;
  }
  if (tools) {
    try { const r = await call('Call the report_number tool with the value 7.', PROBE_TOOL); row.tools = r.toolCalls.some((x) => x.name === 'report_number'); }
    catch (e) { if (signal && signal.aborted) throw e; row.tools = e.status === 429 || e.name === 'TimeoutError' ? null : false; }
  }
  return row;
}

// What a test request means: nothing = the current and team models; "provider" = its models; "provider/model" = that one.
async function testTargets(host, words, { current, limit = 25, all = false, free = false, match = '' } = {}) {
  if (!words.length) {
    const team = host.readState().team || {};
    const list = [current || host.defaultModel(), team.coder, team.reviewer].filter(Boolean);
    const real = list.filter((s) => s.provider !== 'omniroute');
    const seen = new Set();
    return { targets: real.filter((s) => !seen.has(specName(s)) && seen.add(specName(s))), skipped: 0 };
  }
  const targets = []; let skipped = 0;
  for (const w of words) {
    if (!providers.byId(w)) { targets.push(parseSpec(w, current && current.provider !== 'omniroute' ? current.provider : '')); continue; }
    if (w === 'omniroute' || w === 'pretend') throw new Error('Test a real provider, for example: caelix test kilo');
    if (!usable(host, w)) throw new Error(`No key for ${w}. Run: caelix keys add ${w}`);
    let list = await host.listModels(w, true);
    if (!host.keys.has(w)) list = list.filter(providers.usableWithoutKey); else if (free) list = list.filter((m) => m.free);
    if (match) list = list.filter((m) => m.id.toLowerCase().includes(match.toLowerCase()));
    list = [...list].sort((a, b) => !!b.free - !!a.free);
    const take = all ? list : list.slice(0, limit);
    skipped += list.length - take.length;
    targets.push(...take.map((m) => ({ provider: w, model: m.id })));
  }
  return { targets, skipped };
}

function rowText(r) {
  const name = fit(clean(specName(r)), Math.max(24, cols() - 36));
  if (!r.ok) return `  ${c.red('✖')} ${name}  ${c.dim(r.verdict)}`;
  const tools = r.tools === true ? c.green('tools ✔') : r.tools === false ? c.amber('tools ✖') : c.dim('tools ?');
  return `  ${c.green('✔')} ${name}  ${c.dim((r.ms / 1000).toFixed(1) + 's')}  ${tools}`;
}

// Test several at once, printing each result as it arrives.
async function runTests(host, targets, { tools = true, say = (s) => process.stdout.write(s + '\n'), signal, concurrency = 4 } = {}) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length && !(signal && signal.aborted)) {
      const t = targets[next++];
      try { const r = await testModel(host, t, { tools, signal }); results.push(r); say(rowText(r)); } catch (e) { if (!(signal && signal.aborted)) throw e; }
    }
  }));
  return results;
}
function summary(results, skipped) {
  const ok = results.filter((r) => r.ok); const withTools = ok.filter((r) => r.tools === true);
  return `${ok.length} of ${results.length} work${ok.some((r) => r.tools !== null) ? `, ${withTools.length} can use tools` : ''}${skipped ? ` · ${skipped} more not tested (--all)` : ''}`;
}

module.exports = { parseSpec, specName, pickModel, testModel, testTargets, runTests, summary, usable };
