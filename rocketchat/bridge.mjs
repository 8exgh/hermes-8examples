#!/usr/bin/env node
// Rocket.Chat <-> managed Hermes bridge.
//
// Runs on the fleet box (where the hermes-* containers live). Rocket.Chat
// posts an outgoing-webhook to /hook on every message in a hermes channel;
// we forward it to that worker's OpenAI-compatible API server (published on
// loopback by the control plane) and post the reply back via the REST API.
//
// Channel "hermesN" maps to tenant "hermesN" (container "hermes-hermesN").
// A user only ever reaches the worker whose channel they're a member of —
// Rocket.Chat channel membership IS the access control.
//
// Continuity: every (channel, user) pair gets a stable X-Hermes-Session-Id,
// so the worker keeps one conversation per person per channel, exactly like
// a native chat platform.
//
// Outbox: workers message their person proactively (heartbeat, background
// work) by dropping Markdown files in /opt/data/outbox/ — the bridge relays
// those into the channel and moves them to outbox/sent/. No chat credentials
// ever enter a container.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RC_URL = (process.env.RC_URL || 'http://127.0.0.1:3060').replace(/\/$/, '');
const BOT_USER = process.env.RC_BOT_USER || 'hermes-bridge';
const BOT_PASS = process.env.RC_BOT_PASS || '';
const HOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const PORT = Number(process.env.BRIDGE_PORT || 8091);
const FLEET_DIR = process.env.MANAGED_HERMES_DIR || path.join(os.homedir(), 'managed-hermes');
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 600000);
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 10000);

let auth = null; // { authToken, userId }

async function rc(pathname, { method = 'GET', body, useAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (useAuth && auth) {
    headers['X-Auth-Token'] = auth.authToken;
    headers['X-User-Id'] = auth.userId;
  }
  const res = await fetch(`${RC_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`RC ${pathname} ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function login() {
  const j = await rc('/api/v1/login', {
    method: 'POST',
    useAuth: false,
    body: { user: BOT_USER, password: BOT_PASS },
  });
  auth = { authToken: j.data.authToken, userId: j.data.userId };
  console.log(`[bridge] logged in as ${BOT_USER} (${auth.userId})`);
}

async function postMessage(channelName, text) {
  const send = () => rc('/api/v1/chat.postMessage', {
    method: 'POST',
    body: { channel: `#${channelName}`, text },
  });
  try {
    await send();
  } catch (e) {
    // token may have expired — re-login once and retry
    console.warn(`[bridge] post failed (${e.message}); re-login + retry`);
    await login();
    await send();
  }
}

/* Tenant lookup from the control plane's own files: data/tenants.json for the
   API port, tenants/<id>/data/.env for that worker's API server key. Read on
   every message so a re-render (rotated key, new tenant) needs no restart. */
function parseEnv(file) {
  const map = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) map[m[1]] = m[2];
    }
  } catch { /* missing file: caller decides */ }
  return map;
}

function tenantFor(channelName) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(channelName)) return null;
  let tenants = [];
  try {
    tenants = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, 'data', 'tenants.json'), 'utf8'));
  } catch { return null; }
  const t = tenants.find((x) => x.id === channelName && !x.offboardedAt);
  if (!t) return null;
  const env = parseEnv(path.join(FLEET_DIR, 'tenants', t.id, 'data', '.env'));
  if (!env.API_SERVER_KEY) return null;
  return { id: t.id, port: t.gatewayPort, key: env.API_SERVER_KEY };
}

async function runAgent(tenant, sessionId, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${tenant.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.key}`,
        'X-Hermes-Session-Id': sessionId,
        'X-Hermes-Session-Key': `rc:${tenant.id}:${sessionId}`,
      },
      body: JSON.stringify({
        model: tenant.id,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[bridge] ${tenant.id} api ${res.status}: ${text.slice(0, 200)}`);
      return res.status === 429
        ? '⏳ I am in the middle of something — give me a moment and send that again.'
        : '⚠️ Sorry — I hit an error handling that. Please try again in a moment.';
    }
    const json = JSON.parse(text);
    const out = (json?.choices?.[0]?.message?.content ?? '').trim();
    return out || '⚠️ Sorry — I came back empty-handed on that one. Please try again.';
  } catch (e) {
    console.warn(`[bridge] ${tenant.id} request failed: ${e.message}`);
    return '⚠️ Sorry — I hit an error handling that. Please try again in a moment.';
  } finally {
    clearTimeout(timer);
  }
}

/* Stable per-(channel,user) session id. Hermes caps/validates the header, so
   keep it short and safe. */
function sessionIdFor(channelName, userName) {
  const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  return `rc-${safe(channelName)}-${safe(userName)}`;
}

async function handleMessage({ channel_name, user_name, text, bot }) {
  if (bot || user_name === BOT_USER) return; // never react to our own / bot posts
  if (!channel_name || !text) return;
  const tenant = tenantFor(channel_name);
  if (!tenant) {
    console.warn(`[bridge] no active tenant for channel ${channel_name}`);
    return;
  }
  console.log(`[bridge] ${channel_name} <- ${user_name}: ${text.slice(0, 80)}`);
  const reply = await runAgent(tenant, sessionIdFor(channel_name, user_name), text);
  await postMessage(channel_name, reply);
  console.log(`[bridge] ${channel_name} -> replied ${reply.length} chars`);
}

/* Outbox relay: tenants/<id>/data/outbox/*.md -> #<id>, then -> outbox/sent/. */
async function relayOutboxes() {
  let tenants = [];
  try {
    tenants = JSON.parse(fs.readFileSync(path.join(FLEET_DIR, 'data', 'tenants.json'), 'utf8'));
  } catch { return; }
  for (const t of tenants) {
    if (t.offboardedAt) continue;
    const dir = path.join(FLEET_DIR, 'tenants', t.id, 'data', 'outbox');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(md|txt)$/.test(f)).sort();
    } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let body = '';
      try {
        if (!fs.statSync(full).isFile()) continue;
        body = fs.readFileSync(full, 'utf8').trim();
      } catch { continue; }
      try {
        if (body) await postMessage(t.id, body.slice(0, 4000));
        fs.mkdirSync(path.join(dir, 'sent'), { recursive: true });
        fs.renameSync(full, path.join(dir, 'sent', f));
        console.log(`[bridge] ${t.id} outbox -> posted ${f}`);
      } catch (e) {
        console.warn(`[bridge] ${t.id} outbox ${f} failed: ${e.message}`);
      }
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, loggedIn: !!auth }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/hook') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (HOOK_TOKEN && payload.token !== HOOK_TOKEN) {
      res.writeHead(401).end();
      return;
    }
    // ack immediately; process async so a slow agent can't time out the webhook
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    handleMessage(payload).catch((e) => console.error(`[bridge] handle error: ${e.message}`));
  });
});

// Start the webhook receiver immediately so it's reachable, and keep trying to
// log in in the background — Rocket.Chat may be unreachable until the Cloudflare
// tunnel is up. postMessage() re-logs-in on demand if auth isn't ready yet.
server.listen(PORT, () => console.log(`[bridge] listening on :${PORT} -> ${RC_URL}; fleet dir ${FLEET_DIR}`));

(async function loginLoop() {
  for (let attempt = 1; !auth; attempt++) {
    try {
      await login();
    } catch (e) {
      console.warn(`[bridge] login attempt ${attempt} failed (${e.message}); retrying in 15s`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
})();

setInterval(() => {
  if (auth) relayOutboxes().catch((e) => console.error(`[bridge] outbox error: ${e.message}`));
}, OUTBOX_POLL_MS);
