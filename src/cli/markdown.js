'use strict';
// Markdown for the terminal, one line at a time, so a reply can be shown while it streams.
const { c, clean, cols } = require('./theme');

function inline(s) {
  return s.split(/(`[^`]+`)/).map((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return c.sky(part.slice(1, -1));
    return part.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t)).replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, (_, a, t) => a + c.italic(t))
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => c.blue(t) + c.dim(` (${u})`));
  }).join('');
}

function createRenderer() {
  let fence = false;
  return {
    reset() { fence = false; },
    line(raw) {
      const s = clean(raw);
      const f = /^\s*```\s*([\w+-]*)/.exec(s);
      if (f) { fence = !fence; return c.navy(fence ? '┌─ ' + (f[1] || 'code') : '└─'); }
      if (fence) return c.navy('│ ') + c.ice(s);
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(s))) return c.bold(c.blue(inline(m[2])));
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return c.navy('─'.repeat(Math.min(40, cols() - 4)));
      if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(s))) return `${m[1]}${c.blue('•')} ${inline(m[2])}`;
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(s))) return `${m[1]}${c.blue(m[2] + '.')} ${inline(m[3])}`;
      if ((m = /^>\s?(.*)$/.exec(s))) return c.navy('▎ ') + c.dim(inline(m[1]));
      if (/^\s*\|.*\|\s*$/.test(s)) return /^[\s|:-]+$/.test(s) ? c.navy(s) : inline(s).replace(/\|/g, c.navy('│'));
      return inline(s);
    },
  };
}
module.exports = { createRenderer };
