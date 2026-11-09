import http from 'node:http';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CHAT_DATA_DIR || path.join(root, 'data');
const dataFile = path.join(dataDir, 'rooms.enc');
const keyFile = path.join(dataDir, 'storage.key');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 10;
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 5000;
const MAX_MESSAGES_PER_ROOM = 500;
const PORT = Number(process.env.PORT || 3000);

let storageKey;
let rooms = {};
let writeQueue = Promise.resolve();

async function getStorageKey() {
  try { return await readFile(keyFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    try { const handle = await open(keyFile, 'wx', 0o600); await handle.writeFile(key); await handle.close(); return key; }
    catch (createError) { if (createError.code === 'EEXIST') return readFile(keyFile); throw createError; }
  }
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decrypt(payload) {
  const packed = JSON.parse(payload);
  const decipher = createDecipheriv('aes-256-gcm', storageKey, Buffer.from(packed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
  const clear = Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(clear);
}

async function persist() {
  const temp = path.join(dataDir, `rooms-${randomUUID()}.tmp`);
  await writeFile(temp, encrypt(rooms), { mode: 0o600 });
  await rename(temp, dataFile);
}

function mutate(action) {
  const next = writeQueue.then(async () => {
    const result = action();
    await persist();
    return result;
  });
  writeQueue = next.catch(() => {});
  return next;
}

async function initialise() {
  await mkdir(dataDir, { recursive: true });
  storageKey = await getStorageKey();
  try { rooms = decrypt(await readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not open encrypted chat storage: ${error.message}`); rooms = {}; await persist(); }
  await mutate(() => { const now = Date.now(); for (const [code, room] of Object.entries(rooms)) if (room.expiresAt <= now) delete rooms[code]; });
  setInterval(() => mutate(() => { const now = Date.now(); for (const [code, room] of Object.entries(rooms)) if (room.expiresAt <= now) delete rooms[code]; }).catch(() => {}), 6 * 60 * 60 * 1000).unref();
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

function roomCode() {
  let code = '';
  for (const n of randomBytes(ROOM_CODE_LENGTH)) code += alphabet[n % alphabet.length];
  return code;
}

async function bodyJson(req) {
  const pieces = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 12_000) throw Object.assign(new Error('Request is too large.'), { status: 413 }); pieces.push(chunk); }
  try { return JSON.parse(Buffer.concat(pieces).toString('utf8')); }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}

function cleanText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, max);
}

function validCode(code) { return new RegExp(`^[${alphabet}]{${ROOM_CODE_LENGTH}}$`).test(code); }

function securityHeaders(res, secure) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  securityHeaders(res, secure);

  if (url.pathname === '/googlece720df366844541.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return res.end('google-site-verification: googlece720df366844541.html');
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      try {
        const body = await bodyJson(req);
        const label = cleanText(body.label, 48, '') || 'Private chat';
        const room = await mutate(() => {
          let code; do { code = roomCode(); } while (rooms[code]);
          const createdAt = Date.now();
          rooms[code] = { code, createdAt, expiresAt: createdAt + ROOM_TTL_MS, label, messages: [] };
          return { code, label, expiresAt: rooms[code].expiresAt };
        });
        return json(res, 201, room);
      } catch (error) { return json(res, error.status || 500, { error: error.status ? error.message : 'Could not create this chat.' }); }
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/messages)?$/i);
    if (!match) return json(res, 404, { error: 'That chat link was not found.' });
    const code = match[1].toUpperCase();
    if (!validCode(code)) return json(res, 404, { error: 'That chat link was not found.' });
    await writeQueue;
    const existing = rooms[code];
    if (!existing || existing.expiresAt <= Date.now()) return json(res, 404, { error: 'This chat link has expired or does not exist.' });

    if (req.method === 'GET' && url.pathname === `/api/rooms/${code}`) return json(res, 200, { code, label: existing.label, createdAt: existing.createdAt, expiresAt: existing.expiresAt, messages: existing.messages });
    if (req.method === 'POST' && url.pathname === `/api/rooms/${code}/messages`) {
      try {
        const body = await bodyJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const sender = cleanText(body.sender, 32, '') || 'Someone';
        if (!text.trim()) return json(res, 400, { error: 'Write a message first.' });
        if (text.length > MAX_MESSAGE_CHARS) return json(res, 413, { error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` });
        const updated = await mutate(() => {
          const room = rooms[code];
          if (!room || room.expiresAt <= Date.now()) return null;
          if (room.messages.length >= MAX_MESSAGES_PER_ROOM) return 'full';
          const message = { id: randomUUID(), sender, text, createdAt: Date.now() };
          room.messages.push(message);
          room.expiresAt = Date.now() + ROOM_TTL_MS;
          return { expiresAt: room.expiresAt, message };
        });
        if (updated === 'full') return json(res, 409, { error: 'This chat reached its message limit. Create a new chat to continue.' });
        if (!updated) return json(res, 404, { error: 'This chat link has expired.' });
        return json(res, 201, updated);
      } catch (error) { return json(res, error.status || 500, { error: error.status ? error.message : 'Could not save that message.' }); }
    }
    return json(res, 405, { error: 'That action is not available.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/' || new RegExp(`^/c/[${alphabet}]{${ROOM_CODE_LENGTH}}$`, 'i').test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return res.end(await readFile(path.join(root, 'public', 'index.html')));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

initialise().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Pocket Relay listening on port ${PORT}`))).catch(error => { console.error(error); process.exitCode = 1; });
