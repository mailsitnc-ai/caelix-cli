'use strict';
// API keys, encrypted with AES-256-GCM. The master key is held by the operating system:
// macOS Keychain, Windows DPAPI, or (Linux and fallback) a file only your user can read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createKeyStore } = require('../engine/keys');

const SERVICE = process.env.CAELIX_KEYCHAIN_SERVICE || 'CAELIX CLI';
const ACCOUNT = 'caelix-cli';
const quiet = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 60000 };

function backend() {
  if (process.env.CAELIX_KEYSTORE === 'file') return 'file';
  return process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'file';
}

function fromKeychain() {
  const read = () => { try { return execFileSync('/usr/bin/security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'], quiet).trim(); } catch (_) { return ''; } };
  let hex = read();
  if (!hex) {
    // sent on standard input so the secret never shows up in the process list
    execFileSync('/usr/bin/security', ['-i'], { ...quiet, input: `add-generic-password -a "${ACCOUNT}" -s "${SERVICE}" -w "${crypto.randomBytes(32).toString('hex')}"\n` });
    hex = read();
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Could not use the macOS Keychain.');
  return Buffer.from(hex, 'hex');
}

function fromDpapi(dir) {
  const file = path.join(dir, 'master.dpapi');
  const ps = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; $d=[Console]::In.ReadToEnd().Trim(); ' + script], { ...quiet, input }).trim();
  if (!fs.existsSync(file)) fs.writeFileSync(file, ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($d),$null,'CurrentUser'))", crypto.randomBytes(32).toString('base64')), { mode: 0o600 });
  return Buffer.from(ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($d),$null,'CurrentUser'))", fs.readFileSync(file, 'utf8')), 'base64');
}

function fromFile(dir) {
  const file = path.join(dir, 'master.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

function createKeys(dir) {
  let master = null;
  const key = () => {
    if (master) return master;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const b = backend(); master = b === 'keychain' ? fromKeychain() : b === 'dpapi' ? fromDpapi(dir) : fromFile(dir);
    return master;
  };
  const cipher = {
    isEncryptionAvailable: () => { try { key(); return true; } catch (_) { return false; } },
    encryptString(text) {
      const iv = crypto.randomBytes(12); const e = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const body = Buffer.concat([e.update(text, 'utf8'), e.final()]);
      return Buffer.concat([iv, e.getAuthTag(), body]);
    },
    decryptString(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
  const store = createKeyStore(dir, cipher);
  const env = (id) => process.env[`CAELIX_${id.toUpperCase()}_API_KEY`] || '';
  const cache = new Map();
  const get = (id) => { if (env(id)) return env(id); if (!store.has(id)) return ''; if (!cache.has(id)) cache.set(id, store.get(id)); return cache.get(id); };
  return {
    backend, file: store.file, get,
    has: (id) => !!env(id) || store.has(id),
    set(id, value) { store.set(id, value); cache.delete(id); },
    remove(id) { store.remove(id); cache.delete(id); },
    masked(id) { const k = get(id); return k ? '••••••••' + k.slice(-4) + (env(id) ? ' (from environment)' : '') : ''; },
  };
}
module.exports = { createKeys, SERVICE, ACCOUNT };
