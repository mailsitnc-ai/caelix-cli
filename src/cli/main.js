'use strict';
// Command line entry: arguments, subcommands and one-shot (print) mode.
const { c, clean } = require('./theme');
const { createHost, expandMentions, VERSION, agent, providers } = require('./host');
const { MODES } = require('../engine/permissions');

const HELP = `${c.bold(c.blue('✦ CAELIX CLI'))} ${c.dim('v' + VERSION)}  a coding agent in your terminal

${c.sky('Usage')}
  caelix                       start a session in this folder
  caelix "fix the failing test" start with a first message
  caelix -p "question"         answer once and exit (also reads piped input)

${c.sky('Commands')}
  caelix keys [add|remove|base] <provider>
  caelix models [provider]
  caelix test [provider | provider/model ...]   check that models answer and use tools
  caelix team [set <coder> <reviewer> | on | off | status | test]
  caelix sessions
  caelix doctor
  caelix update

${c.sky('Options')}
  -p, --print                  one-shot mode
  -c, --continue               continue the last session in this folder
  -r, --resume [id]            pick (or name) a session to resume
  --model <provider/model>     model to use      --provider <id>
  --mode <mode>                ${MODES.join(', ')}
  --allowed-tools <rules>      e.g. "Write,Edit,Bash(npm *)"
  --disallowed-tools <rules>
  --output-format <format>     text, json or stream-json (with -p)
  --chat                       chat without project tools
  --effort <low|medium|high>
  --team | --no-team           use (or skip) the saved team
  --coder <provider/model>     team: who writes    --reviewer <provider/model>
  (with test) --all  --free  --limit <n>  --match <text>  --no-tools
  --verbose                    show actions in one-shot mode
  --dangerously-skip-permissions
  -v, --version    -h, --help
`;

// "Write,Bash(git log, *)" -> rules; commas inside brackets belong to the rule
const rules = (s) => (String(s).match(/[^,\s(]+(\([^)]*\))?/g) || []);

function parseArgs(argv) {
  const o = { words: [], allow: [], deny: [], format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]; let inline;
    if (a === '--') { o.words.push(...argv.slice(i + 1)); break; }
    const eq = /^(--[\w-]+)=(.*)$/s.exec(a); if (eq) { a = eq[1]; inline = eq[2]; }
    const value = () => { const v = inline !== undefined ? inline : argv[++i]; if (v === undefined) throw new Error(a + ' needs a value'); return v; };
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '-r' || a === '--resume') o.resume = inline !== undefined ? inline : /^[0-9a-f-]{36}$/.test(argv[i + 1] || '') ? argv[++i] : true;
    else if (a === '--model') o.model = value();
    else if (a === '--provider') o.provider = value();
    else if (a === '--mode' || a === '--permission-mode') { o.mode = value(); if (!MODES.includes(o.mode)) throw new Error('Unknown mode ' + o.mode + '. One of: ' + MODES.join(', ')); }
    else if (a === '--dangerously-skip-permissions') o.mode = 'bypassPermissions';
    else if (a === '--allowed-tools') o.allow.push(...rules(value()));
    else if (a === '--disallowed-tools') o.deny.push(...rules(value()));
    else if (a === '--output-format') { o.format = value(); if (!['text', 'json', 'stream-json'].includes(o.format)) throw new Error('Unknown output format ' + o.format); }
    else if (a === '--effort') o.effort = value();
    else if (a === '--chat') o.chat = true;
    else if (a === '--team') o.team = true;
    else if (a === '--no-team') o.team = false;
    else if (a === '--coder') o.coder = value();
    else if (a === '--reviewer') o.reviewer = value();
    else if (a === '--all') o.all = true;
    else if (a === '--free') o.free = true;
    else if (a === '--no-tools') o.noTools = true;
    else if (a === '--match') o.match = value();
    else if (a === '--limit') { o.limit = Number(value()); if (!(o.limit > 0)) throw new Error('--limit needs a positive number'); }
    else if (a === '--verbose') o.verbose = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-') && a.length > 1) throw new Error('Unknown option ' + a + ' (see caelix --help)');
    else o.words.push(a);
  }
  if (o.model && !o.provider) { const [head, ...rest] = o.model.split('/'); if (rest.length && providers.byId(head)) { o.provider = head; o.model = rest.join('/'); } }
  if (o.provider && !providers.byId(o.provider)) throw new Error('Unknown provider ' + o.provider);
  if (o.provider && !o.model) o.model = o.provider === 'omniroute' ? 'auto' : o.provider === 'pretend' ? 'pretend-1' : undefined;
  if (o.provider && !o.model) throw new Error(`--provider ${o.provider} also needs --model (see: caelix models ${o.provider})`);
  return o;
}

async function printMode(host, o) {
  const asked = o.words.join(' ');
  const piped = process.stdin.isTTY ? '' : (await require('./tasks').readStdin(asked ? 3000 : 0)).trim();
  const raw = asked && piped ? `${asked}\n\n<input>\n${piped}\n</input>` : asked || piped;
  if (!raw) throw new Error('Nothing to do: give a message, for example caelix -p "explain this folder"');
  let session = null;
  if (typeof o.resume === 'string') { session = host.load(o.resume); if (!session) throw new Error('No session ' + o.resume); } else if (o.continue) { const last = host.sessions(process.cwd())[0]; session = last && host.load(last.id); }
  if (!session) session = host.newSession({ provider: o.provider, model: o.model, cwd: process.cwd(), mode: o.mode, kind: o.chat ? 'chat' : 'code', effort: o.effort });
  const rt = session.rt;
  if (o.provider) { rt.provider = o.provider; rt.model = o.model; } else if (o.model) rt.model = o.model;
  if (o.mode) rt.st.mode = o.mode;
  const teams = require('./team');
  if (!(o.continue || o.resume) || o.team !== undefined || o.coder || o.reviewer) teams.apply(rt, teams.fromFlags(host, o));

  const abort = new AbortController(); process.once('SIGINT', () => abort.abort());
  const view = o.verbose ? require('./render').createView({ cwd: () => rt.st.cwd, spinner: false, write: (s) => process.stderr.write(s) }) : null;
  let text = ''; let last = ''; let review = ''; let textId = ''; let failed = ''; let stop = ''; let actions = 0; const denied = []; const warnings = [];
  const emit = (e) => {
    if (o.format === 'stream-json') process.stdout.write(JSON.stringify(e) + '\n');
    if (view && e.type !== 'error') view.event(e);
    if (e.type === 'text_start') { text = ''; textId = e.id; } else if (e.type === 'text') text += e.delta; else if (e.type === 'text_replace') text = e.text;
    else if (e.type === 'text_end') { if (text.trim()) { if (textId.startsWith('rv')) review = text.trim(); else last = text.trim(); } }
    else if (e.type === 'tool_start') actions++;
    else if (e.type === 'tool_result' && /denied|Permission/.test(e.output) && e.error) denied.push(e.name);
    else if (e.type === 'error') { if (e.message.startsWith('Reviewer failed')) warnings.push(e.message); else failed = e.message; } else if (e.type === 'stop') stop = e.reason;
  };
  const ask = async (req) => {
    if (req.kind === 'permission') return { decision: 'deny', comment: 'nobody can approve this in one-shot mode. It needs --allowed-tools or --mode.' };
    return req.kind === 'plan' ? 'No one can approve a plan in one-shot mode; give the plan as your answer.' : 'Nobody is available to answer; choose the sensible option yourself.';
  };
  const env = host.envFor(rt, { signal: abort.signal, emit, ask, allow: o.allow, deny: o.deny });
  if (session.meta.title === 'New session') session.meta.title = agent.fallbackTitle(asked || piped);
  await host.connectMcp(rt, env);
  const { text: full, images } = expandMentions(raw, rt.st.cwd);
  await agent.runTurn(rt, env, full, images);
  host.save(session);

  const bad = !!failed || stop === 'error' || stop === 'stopped';
  if (o.format === 'json') process.stdout.write(JSON.stringify({ result: last, review: review || undefined, warnings: warnings.length ? warnings : undefined, is_error: bad, error: failed || undefined, stop_reason: stop, session_id: session.meta.id, provider: rt.provider, model: rt.model, actions, denied, usage: rt.usage }) + '\n');
  else if (o.format === 'text') {
    if (last) process.stdout.write(clean(last) + '\n');
    if (review) process.stdout.write('\n' + clean(review) + '\n');
    for (const w of warnings) process.stderr.write(c.amber(clean(w)) + '\n');
    if (failed) process.stderr.write(c.red('✖ ' + clean(failed)) + '\n');
    if (denied.length) process.stderr.write(c.amber(`Not allowed here: ${[...new Set(denied)].join(', ')}. Use --allowed-tools or --mode.`) + '\n');
    if (stop && !['finished', 'error'].includes(stop)) process.stderr.write(c.amber('Stopped early: ' + stop) + '\n');
  }
  return bad ? 1 : 0;
}

async function testCommand(host, words, o) {
  const models = require('./models');
  const json = o.format !== 'text';
  const { targets, skipped } = await models.testTargets(host, words, { limit: o.limit, all: o.all, free: o.free, match: o.match, current: o.model ? { provider: o.provider || host.defaultModel().provider, model: o.model } : undefined });
  if (!targets.length) throw new Error('Nothing to test. Name a provider or a model, for example: caelix test kilo');
  if (!json) process.stdout.write(c.dim(`  testing ${targets.length} model(s)…`) + '\n');
  const results = await models.runTests(host, targets, { tools: !o.noTools, say: json ? () => {} : undefined });
  if (json) process.stdout.write(JSON.stringify({ results, skipped }) + '\n'); else process.stdout.write(c.dim('  ' + models.summary(results, skipped)) + '\n');
  return results.every((r) => r.ok) ? 0 : 1;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (o.help || o.words[0] === 'help') { process.stdout.write(HELP); return 0; }
  const [cmd, ...rest] = o.words;
  if (cmd === 'update' && !rest.length) return require('./tasks').update();
  const host = createHost();
  try {
    if (!o.print) {
      const tasks = require('./tasks');
      if (cmd === 'keys') { await tasks.keysCommand(host, rest); require('./input').stop(); return 0; }
      if (cmd === 'test' && rest.every((w) => !/\s/.test(w))) return await testCommand(host, rest, o);
      if (cmd === 'team' && rest.every((w) => !/\s/.test(w))) { await require('./team').command(host, rest); require('./input').stop(); return 0; }
      if (cmd === 'models' && rest.length <= 1) { await tasks.modelsCommand(host, rest); return 0; }
      if (cmd === 'doctor' && !rest.length) { await tasks.doctor(host); return 0; }
      if (cmd === 'sessions' && !rest.length) { for (const s of host.sessions().slice(0, 50)) process.stdout.write(`${s.id}  ${new Date(s.updated).toISOString().slice(0, 16).replace('T', ' ')}  ${clean(s.title)}  ${c.dim(s.cwd)}\n`); return 0; }
    }
    if (o.print || !process.stdin.isTTY || !process.stdout.isTTY) return await printMode(host, o);
    await require('./repl').startRepl(host, { ...o, prompt: o.words.join(' ') });
    return 0;
  } finally { host.close(); }
}

function run() {
  if (Number(process.versions.node.split('.')[0]) < 22) { process.stderr.write('CAELIX CLI needs Node 22 or newer. You have ' + process.versions.node + '.\n'); process.exit(1); }
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  main(process.argv.slice(2)).then((code) => {
    // flush before leaving: open sockets from providers would otherwise keep the process alive
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  }, (e) => { require('./input').stop(); process.stderr.write(c.red('✖ ' + e.message) + '\n'); process.exit(1); });
}

module.exports = { run, parseArgs };
