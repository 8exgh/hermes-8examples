# Rocket.Chat ⇄ managed Hermes fleet

Gives issued people a web chat to talk to *their* Hermes worker(s) — with
per-person access control — without Hermes having native Rocket.Chat support.

```
  person's browser                 server7 (home)               fleet box (OVH)
  ────────────────    HTTPS   ┌───────────────────┐        ┌─────────────────────────┐
   chat.8examples.com ──────► │ Rocket.Chat :3060 │        │  bridge :8091           │
   (Cloudflare tunnel)        │  #hermes1 ...     │──hook─► │  ├ POST 127.0.0.1:28001 │ hermes-hermes1 (API server)
                              │  #hermes5         │◄─reply─ │  ├ ...                  │ ...
                              └───────────────────┘  REST  │  └ outbox relay ────────►│ tenants/*/data/outbox
```

## Pieces

- **Rocket.Chat** on server7:3060 (`devops` → `deploy-rocketchat.yml`), the same
  instance the OpenClaw fleet uses.
- **provision.mjs** — creates users `hermes1..hermes5`, five **private**
  channels of the same name, a `hermes-bridge` bot, and one outgoing webhook
  covering the channels. `PASSWORDS_JSON` sets each user's chat password; the
  devops workflow `provision-rocketchat-hermes.yml` defaults it to the
  `SEED_HERMES` passwords in `8examples/src/app/lib/claw-store.ts`, so what
  Rocket.Chat accepts is exactly what the claim page and welcome email hand
  out. Re-running re-applies the passwords to existing users.
- **bridge.mjs** — runs on the fleet box (`deploy-bridge.sh` → systemd
  `hermes-rc-bridge`). Receives the webhook, forwards the message to the
  matching worker's OpenAI-compatible API server with a stable
  `X-Hermes-Session-Id` per (channel, user), posts the reply back, and relays
  each worker's `outbox/` files into its channel.

## Access model

**Channel membership is the permission.** User `hermesK` is a member of only
`#hermesK`, so they can only reach worker hermesK. To issue someone a second
worker, add their account to that channel too (`groups.invite`).

## Bring-up order

1. Provision, from anywhere that can reach the Rocket.Chat API:
   ```
   RC_URL=https://chat.8examples.com RC_ADMIN_PASS=... \
   BRIDGE_HOOK_URL=http://72.251.7.26:8091/hook \
   WEBHOOK_TOKEN=<secret> RC_BOT_PASS=<secret> COUNT=5 node rocketchat/provision.mjs
   ```
   (or `gh workflow run provision-rocketchat-hermes.yml -R 8exgh/devops`).
2. On the fleet box: fill `/etc/hermes/rc-bridge.env` (matching
   `WEBHOOK_TOKEN` / `RC_BOT_PASS`), then `sudo bash rocketchat/deploy-bridge.sh`.
   Open the bridge port so Rocket.Chat can reach it: `sudo ufw allow 8091/tcp`.
3. Test: log into chat.8examples.com as `hermes1`, open `#hermes1`, say hi.

## Notes / caveats

- Replies come from the worker's API server (`/v1/chat/completions`); the
  bridge never execs into containers and no chat credential enters one.
- The bridge posts as the bot and ignores its own messages (no reply loops).
- Long tasks: the API server is synchronous; the bridge waits up to
  `AGENT_TIMEOUT_MS` (10 min). Workers doing longer background work report
  back through their outbox.
- Port 8091 is a public, token-checked endpoint on the fleet box, exactly
  like the OpenClaw bridge's 8090.
