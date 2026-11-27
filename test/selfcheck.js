'use strict';
// Self-check: a pretend AI that needs no key drives the real CLI. Writes checks/latest.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'caelix.js');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const HOME = tmp('caelix-check-home-'); const WORK = tmp('caelix-check-work-');
const ENV = { ...process.env, CAELIX_HOME: HOME, CAELIX_KEYSTORE: 'file', CAELIX_DOCS: path.join(HOME, 'docs'), NO_COLOR: '', FORCE_COLOR: '' };
delete ENV.NO_COLOR; delete ENV.FORCE_COLOR;

const checks = []; const errors = [];
const pass = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: ok ? '' : String(detail || '').slice(0, 900) }); process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`); };

function run(args, { input, cwd = WORK, env = ENV, cmd = process.execPath, pre = [BIN] } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, [...pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; const timer = setTimeout(() => p.kill('SIGKILL'), 90000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.end(input || '');
  });
}
const script = (steps) => 'go PRETEND: ' + JSON.stringify(steps);
const P = ['-p', '--provider', 'pretend'];
const tool = (name, input) => ({ say: 'working', tools: [{ name, input }] });
const json = async (args, opts) => { const r = await run([...args, '--output-format', 'json'], opts); try { return { ...r, j: JSON.parse(r.out.trim().split('\n').pop()) }; } catch (_) { return { ...r, j: {} }; } };

async function main() {
  const t0 = Date.now();
  let r = await run(['--version']); const startMs = Date.now() - t0;
  pass('starts and prints its version', r.code === 0 && /^\d+\.\d+\.\d+\n$/.test(r.out), r.out + r.err);
  r = await run(['--help']); pass('help lists the commands and options', /CAELIX CLI/.test(r.out) && /--allowed-tools/.test(r.out) && /caelix keys/.test(r.out), r.out);
  r = await run(['--nonsense']); pass('an unknown option is refused with a plain message', r.code === 1 && /Unknown option/.test(r.err), r.err);

  r = await run([...P, script([{ say: 'The answer is **42**.' }])]);
  pass('one-shot mode prints only the answer', r.code === 0 && r.out === 'The answer is **42**.\n', JSON.stringify([r.out, r.err]));
  let a = await json([...P, script([{ say: 'json please' }])]);
  pass('--output-format json gives result, stop reason and session id', a.j.result === 'json please' && a.j.stop_reason === 'finished' && /^[0-9a-f-]{36}$/.test(a.j.session_id), a.out + a.err);
  r = await run([...P, '--output-format', 'stream-json', script([{ say: 'streaming' }])]);
  pass('--output-format stream-json emits one event per line', r.out.trim().split('\n').map((l) => JSON.parse(l).type).includes('text'), r.out);
  r = await run([...P], { input: 'piped words PRETEND: [{"say":"got the pipe"}]' });
  pass('reads the message from a pipe', r.out === 'got the pipe\n', r.out + r.err);

  const write = [tool('Write', { file_path: 'made.txt', content: 'made by caelix' }), { say: 'done' }];
  a = await json([...P, script(write)]);
  pass('one-shot mode does not write files without permission, and says so', !fs.existsSync(path.join(WORK, 'made.txt')) && a.j.denied.includes('Write'), a.out);
  a = await json([...P, '--allowed-tools', 'Write', script(write)]);
  pass('--allowed-tools lets that tool run', fs.existsSync(path.join(WORK, 'made.txt')), a.out + a.err);
  a = await json([...P, '--mode', 'auto', '--disallowed-tools', 'Bash(touch *)', script([tool('Bash', { command: 'touch blocked.txt' }), { say: 'done' }])]);
  pass('--disallowed-tools blocks even in auto mode', !fs.existsSync(path.join(WORK, 'blocked.txt')), a.out);
  a = await json([...P, '--mode', 'plan', script([tool('Write', { file_path: 'plan.txt', content: 'x' }), { say: 'done' }])]);
  pass('plan mode changes nothing', !fs.existsSync(path.join(WORK, 'plan.txt')), a.out);

  a = await json([...P, script([{ say: 'first turn' }])]);
  const b = await json(['-p', '--continue', script([{ say: 'second turn' }])]);
  const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', a.j.session_id + '.json'), 'utf8'));
  pass('--continue carries on the last session in this folder', b.j.session_id === a.j.session_id && saved.messages.filter((m) => m.role === 'user').length === 2, JSON.stringify([a.j, b.j]));
  r = await run(['sessions']); pass('caelix sessions lists saved sessions', r.out.includes(a.j.session_id), r.out);

  fs.writeFileSync(path.join(WORK, 'notes.md'), 'The secret word is plum.\n');
  a = await json([...P, 'summarise @notes.md ' + script([{ say: 'ok' }])]);
  const att = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', a.j.session_id + '.json'), 'utf8'));
  pass('@file attaches the file to the message', JSON.stringify(att.messages).includes('The secret word is plum'), JSON.stringify(att.messages).slice(0, 400));

  const loop = 'Open the app and take a screenshot of the window.\nThen save it to the Desktop folder for later.\n'.repeat(60);
  a = await json([...P, script([{ say: loop }, { say: 'short answer' }])]);
  pass('a reply that loops is cut off and asked for again', a.j.result === 'short answer', String(a.j.result).slice(0, 200));

  a = await json([...P, '--mode', 'auto', '--verbose', script([tool('mcp__memory__memory_save', { text: 'prefers blue' }), { say: 'saved' }])]);
  pass('built-in tool servers work', /Saved \(1 memories\)/.test(a.err), a.err);
  a = await json([...P, '--mode', 'auto', '--verbose', script([tool('Bash', { command: 'printf "\\033]0;HACKED\\007\\033[2Jvisible"' }), { say: 'done' }])]);
  pass('command output cannot send control codes to the terminal', a.err.includes('visible') && !a.err.includes('\x1b]0;') && !a.err.includes('\x1b[2J'), JSON.stringify(a.err));

  const secret = 'sk-test-SELFCHECK-1234567890abcd';
  r = await run(['keys', 'add', 'openrouter'], { input: secret + '\n' });
  const list = await run(['keys', 'list']);
  const files = fs.readdirSync(HOME).filter((f) => fs.statSync(path.join(HOME, f)).isFile()).map((f) => fs.readFileSync(path.join(HOME, f), 'utf8')).join('');
  pass('keys are saved encrypted and shown only by their last 4 characters', r.code === 0 && list.out.includes('••••••••abcd') && !(r.out + list.out + files).includes(secret) && !files.includes('SELFCHECK'), r.out + r.err + list.out);
  r = await run(['keys', 'add', 'groq', 'sk-on-the-command-line']);
  pass('a key typed on the command line is refused', r.code === 1 && /shell history/.test(r.err), r.err);
  await run(['keys', 'remove', 'openrouter']); r = await run(['keys', 'list']); pass('keys can be removed', !r.out.includes('abcd'), r.out);

  if (process.platform === 'darwin') {
    const dir = tmp('caelix-check-kc-'); const service = 'CAELIX CLI selfcheck';
    const code = `const k=require(${JSON.stringify(path.join(ROOT, 'src/cli/keystore.js'))}).createKeys(process.argv[1]); if(process.argv[2]==='set') k.set('groq','gsk-keychain-roundtrip-wxyz'); process.stdout.write(k.backend()+' '+k.masked('groq'))`;
    const env = { ...ENV, CAELIX_KEYSTORE: '', CAELIX_KEYCHAIN_SERVICE: service };
    const one = await run([code, dir, 'set'], { env, pre: ['-e'] }); const two = await run([code, dir], { env, pre: ['-e'] });
    pass('macOS Keychain holds the master key and the saved key can be read back', one.out === 'keychain ••••••••wxyz' && two.out === one.out && !fs.readFileSync(path.join(dir, 'keys.enc.json'), 'utf8').includes('gsk-'), one.out + one.err + two.out + two.err);
    try { execFileSync('/usr/bin/security', ['delete-generic-password', '-a', 'caelix-cli', '-s', service], { stdio: 'ignore' }); } catch (_) {}
  }

  if (require('../src/cli/browser').findBrowser()) {
    fs.writeFileSync(path.join(WORK, 'page.html'), '<!doctype html><title>Check page</title><h1>Hello from CAELIX</h1><button onclick="document.querySelector(\'h1\').textContent=\'Clicked now\'">Go</button><canvas id="empty" width="100" height="80"></canvas><script>console.error("deliberate failure")</script>');
    a = await json([...P, '--verbose', script([tool('LookAtPage', { target: 'page.html', clicks: ['Go'] }), { say: 'looked' }])]);
    const s = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', a.j.session_id + '.json'), 'utf8'));
    const seen = (s.messages.find((m) => m.role === 'tool') || {}).content || '';
    pass('sees a page it built: console errors, clicks, elements and blank canvases', /Title: Check page/.test(seen) && /deliberate failure/.test(seen) && /Clicked now/.test(seen) && /click "Go": done/.test(seen) && /canvas #empty is one flat colour/.test(seen), seen);
    a = await json([...P, '--mode', 'auto', script([tool('WriteDocument', { filename: 'report', content: '# Report\n\nBody', format: 'pdf' }), { say: 'made' }])]);
    const pdf = path.join(HOME, 'docs', 'report.pdf');
    pass('makes a PDF document', fs.existsSync(pdf) && fs.readFileSync(pdf).subarray(0, 4).toString() === '%PDF', a.out + a.err);
  } else process.stdout.write('skip page and PDF checks: no Chrome-family browser found\n');

  const providers = require('../src/engine/providers');
  const kept = [{ id: 'a/b:free' }, { id: 'x-free' }, { id: 'paid/model' }, { id: 'priced', free: true }, { id: 'google/lyria-3', free: true }].filter(providers.usableWithoutKey).map((m) => m.id);
  pass('with no key, only free chat models are tried', kept.join(',') === 'a/b:free,x-free,priced', kept.join(','));

  const { layout } = require('../src/cli/input'); const { createRenderer } = require('../src/cli/markdown');
  const l = layout('abcdef\ngh', 7, 4);
  pass('the editor wraps long input and keeps the cursor in the right place', l.rows.join('|') === 'abcd|ef|gh' && l.at.row === 2 && l.at.col === 0, JSON.stringify(l));
  const md = createRenderer();
  pass('Markdown is drawn for the terminal', [md.line('# Title'), md.line('- item **bold**'), md.line('```js'), md.line('**not bold**'), md.line('```')].join('\n') === 'Title\n• item bold\n┌─ js\n│ **not bold**\n└─');

  await teamAndTesting();

  if (process.platform !== 'win32') await interactive();
  else process.stdout.write('skip interactive checks on Windows\n');

  const mem = await run(['-e', `require(${JSON.stringify(path.join(ROOT, 'src/cli/main.js'))}); require(${JSON.stringify(path.join(ROOT, 'src/cli/repl.js'))}); process.stdout.write(String(process.memoryUsage().rss))`], { pre: [] });
  const report = { passed: checks.filter((x) => x.ok).length, total: checks.length, errors, startMs, memoryMB: Math.round(Number(mem.out) / 1048576), node: process.versions.node, at: new Date().toISOString(), checks };
  fs.mkdirSync(path.join(ROOT, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'checks', 'latest.json'), JSON.stringify(report, null, 2));
  fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true });
  process.stdout.write(`\n${report.passed === report.total && !errors.length ? 'PASS' : 'FAIL'} ${report.passed}/${report.total} · start ${startMs} ms · memory ${report.memoryMB} MB\n`);
  process.exit(report.passed === report.total && !errors.length ? 0 : 1);
}

// team mode and model testing, against a fake provider on this computer
async function teamAndTesting() {
  const server = await require('./fake_server').start();
  const env = { ...ENV, CAELIX_COARENA_API_KEY: 'fake-key-for-selfcheck' };
  const go = (args, o = {}) => run(args, { env, ...o });
  await go(['keys', 'base', 'coarena', server.url]);
  const M = (m) => 'coarena/' + m;

  let r = await go(['test', M('good-model'), M('no-tools-model'), M('broke-model'), '--output-format', 'json']);
  let rows = {}; try { for (const x of JSON.parse(r.out).results) rows[x.model] = x; } catch (_) {}
  pass('caelix test reports which models reply and which can use tools', r.code === 1 && rows['good-model'] && rows['good-model'].ok && rows['good-model'].tools === true && rows['no-tools-model'].ok && rows['no-tools-model'].tools === false && !rows['broke-model'].ok && rows['broke-model'].verdict === 'needs credits', r.out + r.err);
  r = await go(['test', 'coarena', '--match', 'good', '--no-tools']);
  pass('caelix test <provider> tests its models, and --match narrows them', r.code === 0 && /good-model/.test(r.out) && /1 of 1 work/.test(r.out) && !/broke/.test(r.out), r.out + r.err);
  r = await go(['test', 'coarena', '--limit', '2']);
  pass('a long list is capped, and says how many were left out', /of 2 work/.test(r.out) && /4 more not tested/.test(r.out), r.out + r.err);
  r = await go(['test', 'groq/some-model']);
  pass('testing a provider without a key says how to add one', r.code === 1 && /caelix keys add groq/.test(r.out), r.out + r.err);

  const dir = tmp('caelix-check-team-');
  r = await go(['team', 'set', M('coder-model'), M('reviewer-model')]);
  const shown = await go(['team', 'status']);
  pass('caelix team saves the coder and reviewer', r.code === 0 && /Team mode on/.test(shown.out) && /coder-model/.test(shown.out) && /reviewer-model/.test(shown.out), r.out + r.err + shown.out);
  server.seen.length = 0;
  let a = await json(['-p', '--mode', 'acceptEdits', 'write the file'], { env, cwd: dir });
  pass('team mode: the coder writes and the reviewer checks it', a.j.result === 'Draft written.' && /APPROVED/.test(a.j.review || '') && server.seen.map((s) => s.model).join(',') === 'coder-model,coder-model,reviewer-model', a.out + a.err + JSON.stringify(server.seen));
  a = await json(['-p', '--mode', 'acceptEdits', '--reviewer', M('strict-reviewer'), 'write the file'], { env, cwd: tmp('caelix-check-team2-') });
  pass('team mode: changes asked for by the reviewer are made', a.j.result === 'Fixed after review.' && /CHANGES NEEDED/.test(a.j.review || ''), a.out + a.err);
  server.seen.length = 0;
  a = await json(['-p', '--no-team', '--model', M('good-model'), 'hello'], { env, cwd: dir });
  pass('--no-team skips the saved team', a.j.result === 'ready' && server.seen.every((s) => s.model === 'good-model') && !a.j.review, a.out + a.err);
  r = await go(['team', 'off']); const off = await go(['team', 'status']);
  pass('team mode can be turned off', /Team mode off/.test(off.out), off.out);
  r = await go(['-p', '--team', 'x'], { env: { ...env, CAELIX_HOME: tmp('caelix-check-empty-') } });
  pass('--team without a reviewer says what to do', r.code === 1 && /needs a reviewer/.test(r.err), r.err);

  if (process.platform !== 'win32') {
    const t = await pty(['--model', M('good-model')], [{ expect: '● Manual' }, { send: '/team\r' }, { expect: 'one model writes' }, { send: '3' }, { expect: 'Turn team mode off' }, { send: '\x1b' }, { sleep: 0.9 }, { expect: 'Team mode on' }, { expect: '· team' }, { send: '/team off\r' }, { expect: 'Team mode off' }, { send: '/test ' + M('good-model') + '\r' }, { expect: 'tools ✔' }, { expect: '1 of 1 work' }, { send: '/test ' + M('good-model') + ' ' + M('no-tools-model') + '\r' }, { expect: 'Switch to one of the working models?' }, { send: '2' }, { expect: 'Now using coarena / no-tools-model' }, { send: '\x04' }], dir, env);
    pass('interactive: the /team menu and /test work, and a working model can be switched to', t.ok && t.exit === 0, tail(t));
  }
  server.close();
}

async function pty(args, steps, cwd = WORK, env = ENV) {
  const r = await run([], { cmd: 'python3', pre: [path.join(__dirname, 'drive_terminal.py')], input: JSON.stringify({ argv: [process.execPath, BIN, ...args], cwd, steps }), env: { ...env, TERM: 'xterm-256color' } });
  try { return JSON.parse(r.out); } catch (_) { errors.push('terminal driver: ' + r.err.slice(0, 500)); return { ok: false, screen: r.err }; }
}
const tail = (r) => JSON.stringify(r.failed) + '\n' + r.screen.slice(-700);

async function interactive() {
  const dir = tmp('caelix-check-tty-');
  const A = ['--provider', 'pretend'];
  const enter = '\r';
  let r = await pty(A, [{ expect: 'CAELIX CLI' }, { expect: '● Manual' }, { send: '/he' }, { expect: '/help' }, { send: '\t' + enter }, { expect: '/resume' }, { expect: '● Manual' }, { send: '/exit' + enter }], dir);
  pass('interactive: banner, command suggestions, tab completion, /help and /exit', r.ok && r.exit === 0, tail(r));

  const ask = script([tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'approved.txt\',\'y\')"' }), { say: 'Ran it for you.' }]);
  r = await pty(A, [{ expect: '● Manual' }, { send: ask + enter }, { expect: 'needs your OK' }, { expect: 'Allow it?' }, { send: enter }, { expect: 'Ran it for you.' }, { expect: '● Manual' }, { send: '\x03' }, { send: '\x03' }], dir);
  pass('interactive: asks before a command, runs it when approved, ctrl+c twice leaves', r.ok && r.exit === 0 && fs.existsSync(path.join(dir, 'approved.txt')), tail(r));

  const no = script([tool('Write', { file_path: 'refused.txt', content: 'no' }), { say: 'Understood, not writing.' }]);
  r = await pty(A, [{ expect: '● Manual' }, { send: no + enter }, { expect: 'Allow it?' }, { send: '\x1b' }, { sleep: 0.7 }, { expect: 'Understood' }, { expect: '● Manual' }, { send: '\x04' }], dir);
  pass('interactive: esc refuses an action and nothing is written', r.ok && !fs.existsSync(path.join(dir, 'refused.txt')), tail(r));

  r = await pty(A, [{ expect: '● Manual' }, { send: '\x1b[Z' }, { expect: '● Accept edits' }, { send: script([tool('Write', { file_path: 'auto.txt', content: 'line one' }), { say: 'Written.' }]) + enter }, { expect: '+ line one' }, { expect: 'Written.' }, { expect: '● Accept edits' }, { send: '\x04' }], dir);
  pass('interactive: shift+tab changes mode and file changes show as a diff', r.ok && fs.existsSync(path.join(dir, 'auto.txt')), tail(r));

  r = await pty(A, [{ expect: '● Manual' }, { send: '\x1b[200~alpha line\rbeta line\x1b[201~' }, { sleep: 0.6 }, { expect: 'beta line' }, { send: '\x03' }, { send: '!echo from-the-shell' + enter }, { expect: '\nfrom-the-shell' }, { send: '\x04' }], dir);
  pass('interactive: pasted lines are not sent early, and !command runs in the shell', r.ok && !r.screen.includes('Pretend AI here'), tail(r));

  const slow = script([tool('Bash', { command: 'sleep 20' }), { say: 'should not appear' }]);
  const started = Date.now();
  r = await pty([...A, '--mode', 'auto'], [{ expect: '● Auto' }, { send: slow + enter }, { expect: 'esc to interrupt' }, { sleep: 1 }, { send: '\x1b' }, { expect: 'Interrupted' }, { expect: '● Auto' }, { send: '\x04' }], dir);
  pass('interactive: esc interrupts a running turn', r.ok && Date.now() - started < 18000, tail(r));

  r = await pty(['--continue'], [{ expect: 'resumed' }, { expect: '● ' }, { send: '/context' + enter }, { expect: 'context about' }, { send: '/diff' + enter }, { expect: 'No file changes' }, { send: '/model' + enter }, { expect: 'Choose a provider' }, { send: '\x1b' }, { sleep: 0.9 }, { send: '/nope' + enter }, { expect: 'Unknown command' }, { send: '\x04' }], dir);
  pass('interactive: --continue replays the session; /context, /diff, /model and unknown commands answer', r.ok && r.exit === 0, tail(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

process.on('uncaughtException', (e) => { errors.push(String(e.stack || e)); console.error(e); process.exit(1); });
main();
