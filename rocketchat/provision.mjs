#!/usr/bin/env node
// Provision Rocket.Chat for the managed Hermes fleet:
//   - a bridge bot account (the thing that posts replies)
//   - N users <prefix>1..<prefix>N (password = username unless PASSWORDS_JSON says otherwise)
//   - N private channels of the same name, each with only its user + the bot
//   - one outgoing webhook that POSTs every hermes-channel message to the bridge
//
// Channel membership IS the access control: user hermesK only sees #hermesK.
// Issue someone a second worker by adding their account to that channel too
// (groups.invite), no other change needed.
//
// Env: RC_URL, RC_ADMIN_USER, RC_ADMIN_PASS, BRIDGE_HOOK_URL, WEBHOOK_TOKEN,
//      RC_BOT_USER, RC_BOT_PASS, PREFIX (default hermes), COUNT (default 5),
//      PASSWORDS_JSON (optional {"hermes1":"...", ...} — keeps the chat
//      passwords identical to the ones the 8examples inventory hands out)
const RC_URL = (process.env.RC_URL || 'http://localhost:3060').replace(/\/$/, '');
const ADMIN_USER = process.env.RC_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.RC_ADMIN_PASS || 'openclaw-admin';
const BOT_USER = process.env.RC_BOT_USER || 'hermes-bridge';
const BOT_PASS = process.env.RC_BOT_PASS || 'hermes-bridge-pass';
const HOOK_URL = process.env.BRIDGE_HOOK_URL || 'http://127.0.0.1:8091/hook';
const HOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'changeme-hook-token';
const PREFIX = process.env.PREFIX || 'hermes';
const COUNT = Number(process.env.COUNT || 5);
const PASSWORDS = JSON.parse(process.env.PASSWORDS_JSON || '{}');

let auth = null;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Auth-Token'] = auth.authToken; headers['X-User-Id'] = auth.userId; }
  const res = await fetch(`${RC_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j };
}

// tolerate "already exists" so the script is re-runnable
async function idempotent(label, fn, existsRe = /already|exists|in use|duplicate/i) {
  const r = await fn();
  if (r.ok) { console.log(`  ok: ${label}`); return r; }
  const msg = r.j?.error || r.j?.message || JSON.stringify(r.j);
  if (existsRe.test(msg)) { console.log(`  skip (exists): ${label}`); return r; }
  console.warn(`  FAIL: ${label} -> ${r.status} ${msg}`);
  return r;
}

async function login() {
  const r = await api('/api/v1/login', { method: 'POST', body: { user: ADMIN_USER, password: ADMIN_PASS } });
  if (!r.ok) throw new Error(`admin login failed: ${JSON.stringify(r.j)}`);
  auth = { authToken: r.j.data.authToken, userId: r.j.data.userId };
  console.log(`logged in as ${ADMIN_USER}`);
}

async function main() {
  await login();

  await idempotent(`bot ${BOT_USER}`, () => api('/api/v1/users.create', {
    method: 'POST',
    body: { username: BOT_USER, name: 'Hermes', email: `${BOT_USER}@fusenv.com`, password: BOT_PASS, roles: ['bot'], requirePasswordChange: false, verified: true },
  }));

  for (let i = 1; i <= COUNT; i++) {
    const name = `${PREFIX}${i}`;
    const password = PASSWORDS[name] || name;
    const created = await idempotent(`user ${name}`, () => api('/api/v1/users.create', {
      method: 'POST',
      body: { username: name, name, email: `${name}@fusenv.com`, password, roles: ['user'], requirePasswordChange: false, verified: true, joinDefaultChannels: false },
    }));
    // An existing user keeps the inventory's password too (re-runs stay aligned).
    if (!created.ok && PASSWORDS[name]) {
      const info = await api(`/api/v1/users.info?username=${name}`);
      if (info.ok && info.j.user) {
        await idempotent(`password ${name}`, () => api('/api/v1/users.update', {
          method: 'POST', body: { userId: info.j.user._id, data: { password } },
        }));
      }
    }
    await idempotent(`group ${name}`, () => api('/api/v1/groups.create', {
      method: 'POST',
      body: { name, members: [name, BOT_USER] },
    }));
  }

  // one outgoing webhook covering all hermes channels — remove + recreate so
  // re-running with a higher COUNT extends coverage (no integrations.update in RC 6.x).
  const channels = Array.from({ length: COUNT }, (_, k) => `#${PREFIX}${k + 1}`).join(',');
  const body = {
    type: 'webhook-outgoing',
    name: 'hermes-bridge',
    enabled: true,
    username: BOT_USER,
    event: 'sendMessage',
    channel: channels,
    urls: [HOOK_URL],
    token: HOOK_TOKEN,
    scriptEnabled: false,
    impersonateUser: false,
  };
  const list = await api('/api/v1/integrations.list?count=0');
  const existing = list.j?.integrations?.find((x) => x.name === 'hermes-bridge' && x.type === 'webhook-outgoing');
  if (existing) {
    await idempotent('remove old webhook', () =>
      api('/api/v1/integrations.remove', { method: 'POST', body: { integrationId: existing._id, type: 'webhook-outgoing' } }));
  }
  await idempotent('create webhook (all channels)', () => api('/api/v1/integrations.create', { method: 'POST', body }));

  console.log(`\nDone. ${COUNT} users/channels + bot + webhook -> ${HOOK_URL}`);
  console.log(`Users: ${PREFIX}1..${PREFIX}${COUNT}. Bot: ${BOT_USER}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
