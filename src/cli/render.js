'use strict';
// Turns engine events into terminal output.
const fs = require('fs');
const path = require('path');
const { c, clean, cols, fit } = require('./theme');
const { createRenderer } = require('./markdown');
const { diffLines } = require('../engine/diff');

const NAMES = { WriteDocument: 'Document', TodoWrite: 'Tasks', AskUserQuestion: 'Question', WebFetch: 'Fetch', WebSearch: 'Search', LookAtPage: 'Look' };
const title = (n) => NAMES[n] || (n.startsWith('mcp__') ? n.split('__').slice(1).join(' · ') : n);
const QUIET = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);

function diffText(before, after, max = 30) {
  const d = diffLines(before, after);
  const rows = d.lines.slice(0, max).map(([op, l]) => {
    const text = fit(clean(l), cols() - 9);
    return '     ' + (op === '+' ? c.green('+ ' + text) : op === '-' ? c.red('- ' + text) : c.dim('  ' + text));
  });
  if (d.lines.length > max) rows.push(c.dim(`     … ${d.lines.length - max} more lines`));
  return { text: rows.join('\n'), add: d.add, del: d.del };
}

function createView({ cwd, spinner = true, write = (s) => process.stdout.write(s) }) {
  const md = createRenderer();
  let buf = ''; let first = true; let timer = null; let spinning = false; let label = 'Working'; let t0 = Date.now(); let frame = 0;
  let stats = { actions: 0, failed: 0, files: new Set() };
  const pending = new Map();
  const spinOff = () => { if (spinning) { write('\r\x1b[2K'); spinning = false; } };
  const out = (line = '') => { spinOff(); write(line + '\n'); };
  const tick = () => { frame++; write('\r\x1b[2K' + c.blue('✦✧'[Math.floor(frame / 4) % 2]) + ' ' + c.sky(label + '…') + c.dim(` ${Math.round((Date.now() - t0) / 1000)}s · esc to interrupt`)); spinning = true; };
  const resume = () => { if (spinner && !timer) timer = setInterval(tick, 120); };
  const pause = () => { clearInterval(timer); timer = null; spinOff(); };
  const textLine = (l) => { out((first ? c.blue('✦ ') : '  ') + md.line(l)); first = false; };
  const flush = () => { if (buf) textLine(buf); buf = ''; };
  const notice = (text, paint = c.dim) => out(paint('  ' + clean(text).replace(/\n/g, '\n  ')));

  function result(e) {
    const p = pending.get(e.id) || {}; pending.delete(e.id);
    if (e.error) stats.failed++;
    if (QUIET.has(e.name) && !e.error) return;
    const many = pending.size > 0 || p.crowded;
    const head = c.navy('  └ ') + (many ? c.dim(title(e.name) + ' ' + fit(clean(p.summary || ''), 30) + ': ') : '');
    if (!e.error && p.file && (e.name === 'Write' || e.name === 'Edit' || e.name === 'NotebookEdit')) {
      let after = ''; try { after = fs.readFileSync(p.file, 'utf8'); } catch (_) {}
      stats.files.add(path.basename(p.file));
      const d = diffText(p.before || '', after, 20);
      out(head + c.green(`+${d.add}`) + ' ' + c.red(`-${d.del}`)); if (d.text) out(d.text); return;
    }
    const lines = clean(e.output).split('\n').filter((l, i, a) => l.trim() || i < a.length - 1);
    const show = e.error ? 6 : 3; const paint = e.error ? c.red : c.dim;
    out(head + paint(fit(lines[0] || '(no output)', Math.max(20, cols() - 6 - (many ? 40 : 0)))));
    for (const l of lines.slice(1, show)) out('    ' + paint(fit(l, cols() - 6)));
    if (lines.length > show) out(c.dim(`    … +${lines.length - show} lines`));
  }

  return {
    out, notice, pause, resume,
    begin() { buf = ''; first = true; t0 = Date.now(); label = 'Working'; stats = { actions: 0, failed: 0, files: new Set() }; pending.clear(); resume(); if (timer) tick(); },
    end() {
      flush(); pause();
      if (stats.actions) out(c.dim(`  ${stats.actions} action${stats.actions > 1 ? 's' : ''}${stats.failed ? `, ${stats.failed} failed` : ''}${stats.files.size ? ' · ' + [...stats.files].slice(0, 5).join(', ') : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`));
    },
    event(e) {
      switch (e.type) {
        case 'text_start': buf = ''; first = true; md.reset(); label = 'Writing'; out(); break;
        case 'text': { buf += e.delta; let i; while ((i = buf.indexOf('\n')) >= 0) { textLine(buf.slice(0, i)); buf = buf.slice(i + 1); } break; }
        case 'text_replace': buf = ''; md.reset(); notice('(the reply above was cut: it was repeating or inventing output)', c.amber); break;
        case 'text_end': flush(); label = 'Working'; break;
        case 'thinking': label = 'Thinking'; break;
        case 'tool_start': {
          flush(); stats.actions++; label = title(e.name);
          const input = e.input || {}; const f = input.file_path || input.notebook_path;
          const p = { name: e.name, summary: e.summary, file: f ? path.resolve(cwd(), f) : null, crowded: pending.size > 0 };
          if (p.file && /^(Write|Edit|NotebookEdit)$/.test(e.name)) { try { p.before = fs.readFileSync(p.file, 'utf8'); } catch (_) { p.before = ''; } }
          pending.set(e.id, p);
          if (!QUIET.has(e.name)) out('\n' + c.blue('◆ ') + c.bold(title(e.name)) + '  ' + c.ice(fit(clean(e.summary).replace(/\n/g, ' ⏎ '), cols() - title(e.name).length - 6)));
          break;
        }
        case 'tool_result': result(e); label = 'Working'; break;
        case 'todos': {
          out(); out(c.blue('◆ ') + c.bold('Tasks'));
          for (const t of e.todos) out('  ' + (t.status === 'completed' ? c.green('✔ ') + c.dim(clean(t.content)) : t.status === 'in_progress' ? c.blue('▶ ') + c.bold(clean(t.content)) : c.navy('○ ') + clean(t.content)));
          break;
        }
        case 'subagent': notice((e.phase === 'start' ? '↳ sub-agent: ' : '↲ sub-agent done: ') + e.description, c.sky); break;
        case 'info': flush(); notice(e.text); break;
        case 'route': label = 'Asking ' + e.model; notice(`→ ${e.provider} / ${e.model}`); break;
        case 'route_note': notice(e.message); break;
        case 'route_fail': notice(`${e.provider} failed (${e.error}); trying the next one`, c.amber); break;
        case 'compacted': notice(`Conversation compacted (${e.before} → ${e.after} messages).`); break;
        case 'reset': notice('Context was summarised to free space.'); break;
        case 'error': flush(); out(c.red('✖ ' + clean(e.message))); break;
        case 'stop': flush(); if (e.reason !== 'finished' && e.reason !== 'stopped') notice('Why it stopped: ' + e.detail, c.amber); else if (e.reason === 'stopped') notice('Interrupted.', c.amber); break;
        case 'bg_start': notice(`background task ${e.id} started: ${fit(clean(e.command), 60)}`); break;
        case 'bg_done': notice(`background task ${e.id} finished (exit ${e.code})`); break;
      }
    },
  };
}
module.exports = { createView, diffText, title };
