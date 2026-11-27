'use strict';
// Drives an installed Chrome-family browser, headless, over its DevTools protocol. Used to look at pages
// the agent built, to make PDFs, and as an extra web-search route.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

function findBrowser() {
  if (process.env.CAELIX_BROWSER) return process.env.CAELIX_BROWSER;
  const mac = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'].flatMap((n) => [`/Applications/${n}.app/Contents/MacOS/${n}`, `${os.homedir()}/Applications/${n}.app/Contents/MacOS/${n}`]);
  const win = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [path.join(d, 'Google/Chrome/Application/chrome.exe'), path.join(d, 'Microsoft/Edge/Application/msedge.exe')]);
  const linux = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].flatMap((n) => String(process.env.PATH || '').split(':').map((d) => path.join(d, n)));
  const list = process.platform === 'darwin' ? mac : process.platform === 'win32' ? win : linux;
  return list.find((f) => fs.existsSync(f)) || '';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn(tab) in a fresh throwaway browser, then close it.
async function withTab(fn, { width = 1280, height = 800, signal } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('No Chrome, Chromium, Edge or Brave was found (set CAELIX_BROWSER to its path).');
  if (typeof WebSocket !== 'function') throw new Error('This needs Node 22 or newer.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'caelix-browser-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} };
  if (signal) signal.addEventListener('abort', kill, { once: true });
  let ws = null;
  try {
    const url = await new Promise((resolve, reject) => {
      let log = ''; const timer = setTimeout(() => reject(new Error('The browser did not start.')), 20000);
      proc.stderr.on('data', (d) => { log += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (m) { clearTimeout(timer); resolve(m[1]); } });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); }); proc.on('exit', () => { clearTimeout(timer); reject(new Error('The browser closed while starting.')); });
    });
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not connect to the browser.')); });
    let id = 0; const pending = new Map(); const listeners = [];
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(j.id)) { const p = pending.get(j.id); pending.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result); } else if (j.method) listeners.forEach((l) => l(j.method, j.params));
    };
    ws.onclose = () => { for (const p of pending.values()) p.rej(new Error('The browser closed.')); pending.clear(); };
    const raw = (method, params, sessionId) => new Promise((res, rej) => {
      const n = ++id; const timer = setTimeout(() => { pending.delete(n); rej(new Error(method + ' timed out')); }, 20000);
      pending.set(n, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: n, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => raw(method, params, sessionId);
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable')]);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const tab = {
      send, on: (l) => listeners.push(l),
      async goto(target, limit = 15000) {
        const loaded = new Promise((res) => listeners.push((m) => m === 'Page.loadEventFired' && res()));
        const r = await send('Page.navigate', { url: target });
        if (r.errorText) throw new Error(r.errorText);
        await Promise.race([loaded, wait(limit)]);
      },
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'script error');
        return r.result.value;
      },
    };
    return await fn(tab);
  } finally {
    if (signal) signal.removeEventListener('abort', kill);
    try { if (ws) ws.close(); } catch (_) {}
    const gone = new Promise((r) => proc.once('exit', r)); kill(); await Promise.race([gone, wait(2000)]);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  }
}

async function renderPdf(file, html) {
  const src = path.join(os.tmpdir(), `caelix-doc-${process.pid}-${Date.now()}.html`); fs.writeFileSync(src, html);
  try {
    await withTab(async (tab) => { await tab.goto(pathToFileURL(src).href); const r = await tab.send('Page.printToPDF', { printBackground: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); });
  } finally { try { fs.unlinkSync(src); } catch (_) {} }
  return file;
}

// blank 2D canvases are the usual sign that a game or chart did not draw
const CANVAS = `Array.from(document.querySelectorAll('canvas')).map((cv, i) => { try { const g = cv.getContext('2d'); if (!g || cv.width < 5 || cv.height < 5) return null; const d = g.getImageData(0, 0, cv.width, cv.height).data; for (let p = 4; p < d.length; p += 4 * 97) if (d[p] !== d[0] || d[p+1] !== d[1] || d[p+2] !== d[2] || d[p+3] !== d[3]) return null; return 'canvas ' + (cv.id ? '#' + cv.id : i + 1) + ' is one flat colour: nothing seems to be drawn on it'; } catch (_) { return null; } }).filter(Boolean)`;

async function lookAtPage({ target, cwd, width, height, wait_ms, clicks, keys }, { PROBE, ocr }) {
  let url = String(target || '');
  if (!/^(https?|file):\/\//i.test(url)) { const f = path.resolve(cwd || '.', url); if (!url || !fs.existsSync(f)) throw new Error('No such file: ' + f); url = pathToFileURL(f).href; }
  const w = Math.min(2400, Math.max(320, width || 1280)); const h = Math.min(1800, Math.max(320, height || 800));
  return withTab(async (tab) => {
    const logs = []; const log = (kind, msg) => { if (logs.length < 25) logs.push(`${kind}: ${String(msg).slice(0, 300)}`); };
    tab.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') log('error', (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
      else if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) log(p.type, p.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
      else if (method === 'Log.entryAdded' && p.entry.level === 'error') log('error', p.entry.text + ' ' + (p.entry.url || ''));
      else if (method === 'Page.javascriptDialogOpening') tab.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
    await tab.goto(url);
    await wait(Math.min(10000, Math.max(300, wait_ms || 900)));
    const done = [];
    for (const q of (clicks || []).slice(0, 10)) {
      const hit = await tab.eval(`(() => { const q = ${JSON.stringify(String(q))}; let e = null; try { e = document.querySelector(q); } catch (_) {} if (!e) e = Array.from(document.querySelectorAll('button,a,[role=button],input,label,li,div,span')).filter((x) => (x.innerText || x.value || '').trim().toLowerCase() === q.toLowerCase()).pop(); if (!e) return false; e.click(); return true; })()`);
      done.push(`click "${q}": ${hit ? 'done' : 'NOTHING MATCHED'}`); await wait(350);
    }
    for (const k of (keys || []).slice(0, 30)) {
      const key = String(k); const text = key.length === 1 ? key : undefined;
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...(text ? { text } : {}) }); await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      done.push('pressed ' + key); await wait(150);
    }
    const p = await tab.eval(PROBE);
    const problems = p.problems.concat(await tab.eval(CANVAS));
    const dir = path.join(os.tmpdir(), 'caelix-shots'); fs.mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(shot, Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const out = [`Page: ${url}`, `Title: ${p.title || '(none)'} | viewport ${p.W}x${p.H}, content ${p.scrollW}x${p.scrollH} | background ${p.bg}`];
    if (done.length) out.push('Interactions: ' + done.join('; '));
    out.push(logs.length ? 'Console errors and warnings:\n' + logs.map((l) => '- ' + l).join('\n') : 'Console: no errors.');
    out.push(problems.length ? 'Problems seen:\n' + problems.map((x) => '- ' + x).join('\n') : 'Problems seen: none detected automatically.');
    out.push('Visible elements (x,y widthxheight in pixels):\n' + (p.items.map((i) => `- ${i.el} @${i.x},${i.y} ${i.w}x${i.h}${i.text ? ` "${i.text}"` : ''}${i.size ? ' ' + i.size : ''}${i.color ? ' text ' + i.color : ''}${i.bg ? ' bg ' + i.bg : ''}`).join('\n') || '(none)'));
    try { const rows = await ocr(shot); out.push('Text actually readable on the screenshot:\n' + (rows.slice(0, 120).map((r) => r.t).join(' | ') || '(none)')); } catch (e) { out.push('Screenshot text could not be read: ' + e.message); }
    out.push('Screenshot saved: ' + shot);
    return out.join('\n');
  }, { width: w, height: h });
}

module.exports = { findBrowser, withTab, renderPdf, lookAtPage };
