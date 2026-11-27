'use strict';
// CAELIX CLI look: dark blue and blue.
const env = process.env;
const color = !env.NO_COLOR && env.TERM !== 'dumb' && (process.stdout.isTTY || !!env.FORCE_COLOR);
const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '') || ['iTerm.app', 'vscode', 'ghostty', 'WezTerm'].includes(env.TERM_PROGRAM);

// name -> [r, g, b, 256-colour fallback]
const PALETTE = {
  navy: [30, 58, 138, 19], blue: [59, 130, 246, 33], sky: [125, 180, 255, 111], ice: [191, 219, 254, 153],
  dim: [122, 136, 165, 103], red: [248, 113, 113, 203], green: [74, 222, 128, 78], amber: [251, 191, 36, 214],
};
const sgr = (name, bg) => { const [r, g, b, x] = PALETTE[name]; return `\x1b[${bg ? 48 : 38};${truecolor ? `2;${r};${g};${b}` : `5;${x}`}m`; };
const paint = (name) => (s) => (color ? sgr(name) + s + '\x1b[39m' : String(s));
const c = Object.fromEntries(Object.keys(PALETTE).map((n) => [n, paint(n)]));
c.bold = (s) => (color ? `\x1b[1m${s}\x1b[22m` : String(s));
c.badge = (s) => (color ? `${sgr('navy', true)}\x1b[1m\x1b[38;5;231m ${s} \x1b[39m\x1b[22m\x1b[49m` : `[${s}]`);
c.italic = (s) => (color ? `\x1b[3m${s}\x1b[23m` : String(s));

// Text from models, files and commands must never be able to drive the terminal.
const clean = (s) => String(s == null ? '' : s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')
  .replace(/\r\n/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function charWidth(ch) {
  const n = ch.codePointAt(0);
  if ((n >= 0x300 && n <= 0x36f) || n === 0x200d || (n >= 0xfe00 && n <= 0xfe0f)) return 0;
  if ((n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xff00 && n <= 0xff60) || (n >= 0x1f300 && n <= 0x1faff) || (n >= 0x20000 && n <= 0x3fffd)) return 2;
  return 1;
}
const width = (s) => { let w = 0; for (const ch of plain(s)) w += charWidth(ch); return w; };
const cols = () => Math.max(40, process.stdout.columns || 80);
// cut a plain string to a number of columns
function fit(s, max) { s = String(s); if (width(s) <= max) return s; let w = 0; let out = ''; for (const ch of s) { w += charWidth(ch); if (w > max - 1) break; out += ch; } return out + '…'; }

function banner({ version, model, cwd, mode, kind }) {
  const inner = Math.min(cols() - 4, 66);
  const row = (s = '') => c.navy('│ ') + s + ' '.repeat(Math.max(0, inner - 2 - width(s))) + c.navy(' │');
  return [
    c.navy('╭' + '─'.repeat(inner) + '╮'),
    row(c.blue('✦ ') + c.bold(c.blue('CAELIX')) + c.bold(c.sky(' CLI')) + c.dim('  v' + version)),
    row(),
    row(c.dim('model  ') + c.ice(fit(model, inner - 10))),
    row(c.dim('folder ') + c.ice(fit(kind === 'chat' ? '(chat: no project folder)' : cwd, inner - 10))),
    row(c.dim('mode   ') + c.ice(mode)),
    c.navy('╰' + '─'.repeat(inner) + '╯'),
    c.dim('  /help for commands · shift+tab changes mode · esc interrupts'),
  ].join('\n');
}

module.exports = { c, clean, plain, width, charWidth, cols, fit, banner, color };
