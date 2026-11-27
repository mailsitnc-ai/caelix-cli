'use strict';
// Keyboard handling: one key stream with a stack of listeners, a multi-line prompt editor, menus and hidden input.
const readline = require('readline');
const { c, cols, charWidth, width, fit, clean } = require('./theme');

const stack = [];
let started = false;
function start() {
  if (started) return; started = true;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?2004h'); // bracketed paste: pasted new lines do not send the message
  process.stdin.on('keypress', (str, key) => { const h = stack[stack.length - 1]; if (h) h(str, key || {}); });
  process.on('exit', stop);
}
function stop() { if (!started) return; process.stdout.write('\x1b[?2004l\x1b[?25h'); try { process.stdin.setRawMode(false); } catch (_) {} process.stdin.pause(); }
function listen(handler) { start(); process.stdin.resume(); stack.push(handler); return () => { const i = stack.lastIndexOf(handler); if (i >= 0) stack.splice(i, 1); }; }

// A block of lines that can be redrawn in place. `at` is where the cursor should rest.
function block() {
  let row = 0;
  const up = () => { if (row) process.stdout.write(`\x1b[${row}A`); process.stdout.write('\r\x1b[J'); row = 0; };
  return {
    draw(lines, at) {
      up();
      process.stdout.write(lines.join('\n'));
      const target = at || { row: lines.length - 1, col: width(lines[lines.length - 1]) };
      const back = lines.length - 1 - target.row;
      if (back) process.stdout.write(`\x1b[${back}A`);
      process.stdout.write('\r' + (target.col ? `\x1b[${target.col}C` : ''));
      row = target.row;
    },
    clear: up,
  };
}

// hard-wrap the buffer ourselves so the cursor position is always known
function layout(buf, cursor, room) {
  const rows = ['']; let w = 0; let at = { row: 0, col: 0 }; let i = 0;
  for (const ch of buf) {
    const here = i === cursor; i += ch.length;
    if (ch === '\n') { if (here) at = { row: rows.length - 1, col: w }; rows.push(''); w = 0; continue; }
    const cw = charWidth(ch);
    if (w + cw > room) { rows.push(''); w = 0; }
    if (here) at = { row: rows.length - 1, col: w };
    rows[rows.length - 1] += ch; w += cw;
  }
  if (cursor >= buf.length) at = { row: rows.length - 1, col: w };
  return { rows, at };
}

const isEnter = (key) => key.name === 'return' || key.name === 'enter';

// Returns the typed message, or null when the user wants to leave.
function prompt({ history = [], suggest = () => [], footer = () => '', onShiftTab, initial = '' } = {}) {
  return new Promise((resolve) => {
    const ui = block(); const pastes = []; let buf = initial; let cur = buf.length; let hi = history.length; let draft = ''; let pasting = null; let leaveAt = 0; let note = '';
    const render = () => {
      const room = cols() - 3;
      const { rows, at } = layout(buf, cur, room);
      const first = Math.max(0, Math.min(at.row - 5, rows.length - 12)); const shown = rows.slice(first, first + 12);
      const rule = c.navy('─'.repeat(cols() - 1));
      const lines = [rule, ...shown.map((r, i) => (first + i === 0 ? c.blue('› ') : '  ') + r), rule];
      lines.push(c.dim('  ') + (note ? c.amber(note) : footer()));
      for (const s of suggest(buf, cur).slice(0, 6)) { const label = fit(s.label, cols() - 4); lines.push('  ' + c.sky(label) + c.dim(s.hint ? fit('  ' + s.hint, Math.max(1, cols() - 4 - width(label))) : '')); }
      ui.draw(lines, { row: 1 + at.row - first, col: 2 + at.col });
    };
    const set = (text, pos) => { buf = text; cur = pos === undefined ? text.length : pos; };
    const insert = (s) => set(buf.slice(0, cur) + s + buf.slice(cur), cur + s.length);
    const finish = (value) => {
      off(); process.stdout.removeListener('resize', render);
      ui.clear();
      if (value !== null) process.stdout.write(value.split('\n').slice(0, 20).map((l, i) => (i ? '  ' : c.blue('› ')) + c.bold(clean(l))).join('\n') + '\n');
      resolve(value === null ? null : value.replace(/\[paste #(\d+) \+\d+ lines\]/g, (m, n) => (pastes[n - 1] !== undefined ? pastes[n - 1] : m)));
    };
    const endPaste = () => {
      const text = clean(pasting.replace(/\r\n?/g, '\n')); pasting = null;
      const n = text.split('\n').length;
      if (n > 6 || text.length > 800) { pastes.push(text); insert(`[paste #${pastes.length} +${n} lines]`); } else insert(text);
    };
    const move = (dir) => { // up/down: inside a multi-line message first, then history
      const room = cols() - 3; const { rows, at } = layout(buf, cur, room);
      if (dir < 0 && at.row === 0) { if (hi === history.length) draft = buf; if (hi > 0) set(history[--hi]); return; }
      if (dir > 0 && at.row === rows.length - 1) { if (hi < history.length) { hi++; set(hi === history.length ? draft : history[hi]); } return; }
      const want = at.row + dir; let best = cur;
      for (let p = 0; p <= buf.length; p++) { const l = layout(buf, p, room).at; if (l.row === want && l.col <= at.col) best = p; if (l.row > want) break; }
      cur = best;
    };
    const onKey = (str, key) => {
      note = '';
      const seq = key.sequence || str || '';
      if (key.name === 'paste-start' || seq === '\x1b[200~') { pasting = ''; return; }
      if (pasting !== null) { if (key.name === 'paste-end' || seq === '\x1b[201~') { endPaste(); render(); } else pasting += str !== undefined ? str : seq; return; }
      if (key.ctrl && key.name === 'c') {
        if (buf) { set(''); return render(); }
        if (Date.now() - leaveAt < 2000) return finish(null);
        leaveAt = Date.now(); note = 'press ctrl+c again to exit'; return render();
      }
      if (key.ctrl && key.name === 'd') { if (!buf) return finish(null); set(buf.slice(0, cur) + buf.slice(cur + 1), cur); return render(); }
      if (key.name === 'tab' && key.shift) { if (onShiftTab) onShiftTab(); return render(); }
      if (key.name === 'tab') { const s = suggest(buf, cur)[0]; if (s) set(s.value, s.cursor); return render(); }
      if ((isEnter(key) && key.meta) || seq === '\n' || seq === '\x1b\r') { insert('\n'); return render(); }
      if (isEnter(key)) {
        if (buf.slice(0, cur).endsWith('\\')) { set(buf.slice(0, cur - 1) + '\n' + buf.slice(cur), cur); return render(); }
        if (!buf.trim()) return;
        return finish(buf);
      }
      if (key.name === 'escape') set('');
      else if (key.name === 'backspace') { if (key.meta) { const left = buf.slice(0, cur).replace(/\S+\s*$/, ''); set(left + buf.slice(cur), left.length); } else if (cur) set(buf.slice(0, cur - 1) + buf.slice(cur), cur - 1); }
      else if (key.name === 'delete') set(buf.slice(0, cur) + buf.slice(cur + 1), cur);
      else if (key.name === 'left') cur = Math.max(0, cur - 1);
      else if (key.name === 'right') cur = Math.min(buf.length, cur + 1);
      else if (key.name === 'up') move(-1);
      else if (key.name === 'down') move(1);
      else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cur = cur ? buf.lastIndexOf('\n', cur - 1) + 1 : 0;
      else if (key.name === 'end' || (key.ctrl && key.name === 'e')) { const n = buf.indexOf('\n', cur); cur = n < 0 ? buf.length : n; }
      else if (key.ctrl && key.name === 'u') set(buf.slice(cur), 0);
      else if (key.ctrl && key.name === 'k') set(buf.slice(0, cur), cur);
      else if (key.ctrl && key.name === 'w') { const left = buf.slice(0, cur).replace(/\S+\s*$/, ''); set(left + buf.slice(cur), left.length); }
      else if (key.ctrl && key.name === 'l') process.stdout.write('\x1b[2J\x1b[H');
      else if (str && !key.ctrl && !key.meta && str >= ' ') insert(str);
      render();
    };
    const off = listen(onKey); process.stdout.on('resize', render); render();
  });
}

// Arrow-key menu. options: [{label, hint}] . Returns the chosen index, or -1.
function select(title, options, { filter = false, start: at = 0 } = {}) {
  return new Promise((resolve) => {
    const ui = block(); let q = ''; let sel = Math.max(0, at);
    const visible = () => options.map((o, i) => ({ ...o, i })).filter((o) => !q || (o.label + ' ' + (o.hint || '')).toLowerCase().includes(q.toLowerCase()));
    const render = () => {
      const list = visible(); sel = Math.min(Math.max(0, sel), Math.max(0, list.length - 1));
      const first = Math.max(0, Math.min(sel - 4, list.length - 10));
      const lines = [c.bold(c.blue(fit(title, cols() - 2)))];
      if (filter) lines.push(c.dim('  filter: ') + q);
      list.slice(first, first + 10).forEach((o, k) => {
        const on = first + k === sel; const label = fit(clean(o.label), cols() - 8);
        lines.push((on ? c.blue('❯ ') + c.bold(c.sky(label)) : '  ' + label) + c.dim(o.hint ? fit('  ' + clean(o.hint), Math.max(1, cols() - 4 - width(label))) : ''));
      });
      if (!list.length) lines.push(c.dim('  nothing matches'));
      lines.push(c.dim(`  ↑↓ move · enter choose · esc cancel${list.length > 10 ? ` · ${sel + 1}/${list.length}` : ''}`));
      ui.draw(lines);
    };
    const done = (i) => { off(); ui.clear(); resolve(i); };
    const off = listen((str, key) => {
      const list = visible();
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(-1);
      if (isEnter(key)) return list[sel] ? done(list[sel].i) : undefined;
      if (key.name === 'up') sel = (sel - 1 + list.length) % (list.length || 1);
      else if (key.name === 'down' || key.name === 'tab') sel = (sel + 1) % (list.length || 1);
      else if (filter && key.name === 'backspace') q = q.slice(0, -1);
      else if (filter && str && str >= ' ' && !key.ctrl) { q += str; sel = 0; }
      else if (!filter && /^[1-9]$/.test(str || '') && list[+str - 1]) return done(list[+str - 1].i);
      render();
    });
    render();
  });
}

// One line of input; `hidden` shows dots (used for keys).
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const ui = block(); let v = '';
    const render = () => { const room = Math.max(10, cols() - question.length - 4); const shown = (hidden ? '•'.repeat(v.length) : v).slice(-room); ui.draw([c.blue(question + ' ') + shown]); };
    const done = (x) => { off(); process.stdout.write('\n'); resolve(x); };
    const off = listen((str, key) => {
      const seq = key.sequence || '';
      if (seq === '\x1b[200~' || seq === '\x1b[201~' || /^paste-/.test(key.name || '')) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null);
      if (isEnter(key)) return done(v);
      if (key.name === 'backspace') v = v.slice(0, -1);
      else if (key.ctrl && key.name === 'u') v = '';
      else if (str && !key.ctrl && str >= ' ') v += str;
      render();
    });
    render();
  });
}

module.exports = { listen, prompt, select, ask, stop, layout };
