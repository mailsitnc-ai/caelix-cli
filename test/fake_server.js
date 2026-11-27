'use strict';
// A tiny stand-in for a model provider (OpenAI-style, streaming), used by the self-check.
const http = require('http');
const MODELS = ['good-model', 'no-tools-model', 'broke-model', 'coder-model', 'reviewer-model', 'strict-reviewer'];

function reply(model, body) {
  const msgs = body.messages; const last = msgs[msgs.length - 1];
  const asked = [...msgs].reverse().find((m) => m.role === 'user');
  const text = typeof asked.content === 'string' ? asked.content : '';
  const call = (name, args) => ({ tool_calls: [{ index: 0, id: 'c' + Math.random().toString(36).slice(2, 8), function: { name, arguments: JSON.stringify(args) } }] });
  if (model === 'coder-model') {
    if (last.role === 'tool') return { content: /reviewer checked your work/.test(text) ? 'Fixed after review.' : 'Draft written.' };
    return call('Write', { file_path: 'team.txt', content: /reviewer checked your work/.test(text) ? 'final version' : 'first draft' });
  }
  if (model === 'reviewer-model') return { content: 'APPROVED\nLooks fine.' };
  if (model === 'strict-reviewer') return { content: /first draft/.test(text) ? 'CHANGES NEEDED\n1. team.txt: finish the draft.' : 'APPROVED\nFine now.' };
  if (body.tools && model !== 'no-tools-model' && /report_number/.test(text)) return call('report_number', { value: 7 });
  return { content: 'ready' };
}

function start() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      const body = JSON.parse(raw); seen.push({ model: body.model, auth: req.headers.authorization || '' });
      if (body.model === 'broke-model') { res.statusCode = 402; return res.end('{"error":"no credits"}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = reply(body.model, body);
      res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => { server.closeAllConnections(); server.close(); } })));
}
module.exports = { start };
