# Managed Hermes

Control plane for a fleet of **managed Hermes Agent workers** — one per customer.
The customer is a non-technical person who just messages "their worker" on
Rocket.Chat or Telegram; you operate everything behind it: provisioning,
capabilities, secrets, updates, and the product's habit-building nudge loop.

It is the Hermes counterpart of [`openclaw-8examples`](https://github.com/8exgh/openclaw-8examples)
and lives on the same fleet box (the OVH VM that runs the `openclaw-*`
containers): same host, same Rocket.Chat, same phone gateway, same telemetry
pattern, different agent runtime.

```
                 ┌─────────────────────────────────────────┐
                 │ control plane (this repo)               │
  signup ──────► │  ops.ts        capability registry      │
  enable phone ► │  nudge engine  fleet updater (image/)   │
                 └───────┬─────────────────────────────────┘
                         │ renders + docker compose up
        ┌────────────────┼──────────────────┐
        ▼                ▼                  ▼
  tenants/hermes1/  tenants/hermes2/   tenants/hermes3/
   data/config.yaml  data/config.yaml   data/config.yaml  ← per-tenant Hermes config ($HERMES_HOME)
   data/.env         data/.env          data/.env         ← per-tenant secrets (provider key, API server, webhook)
   data/workspace/   data/workspace/    data/workspace/   ← AGENTS/HEARTBEAT/capabilities/nudges
   [container]       [container]        [container]       ← hermes-8examples image (upstream + Xvfb + Chromium)
        ▲                ▲                  ▲
     Rocket.Chat      Telegram           Rocket.Chat      ← the customer just texts
```

## Quickstart

```bash
npm install

# Pull the CI-built fleet image (upstream nousresearch/hermes-agent + headful Chromium on Xvfb + telemetry)
npm run cli -- update            # pulls + pins ghcr.io/8exgh/hermes-8examples, (re)renders every tenant
MH_BUILD_LOCAL=1 npm run cli -- update   # development: build image/ here instead

# Provision a customer (renders tenants/<id>/ and starts their container if docker is up)
npm run cli -- signup --id hermes1 --name "Hermes 1"
npm run cli -- signup --name "Ana Reyes" --email ana@example.com --enable email,calendar

# See the fleet
npm run cli -- list
npm run cli -- status

# Toggle capabilities later — re-renders config + workspace and restarts the container
npm run cli -- enable hermes1 phone
npm run cli -- disable hermes1 phone

# Run the nudge engine (do this from cron, e.g. hourly)
npm run cli -- nudge

# Ship the newest Hermes + newest managed templates to every tenant
# (--canary updates that tenant first and halts if it comes up unhealthy)
npm run cli -- update --canary hermes1

# Offboarding: stop + reclaim the ports; --purge-data also deletes everything
# stored about the person (the deletion-request path)
npm run cli -- offboard hermes1
npm run cli -- offboard hermes1 --purge-data --yes

# Or drive everything over HTTP (for your signup form / admin UI)
MH_ADMIN_TOKEN=secret npm run serve   # POST /signup, GET /tenants, POST /fleet/update, ...
```

`--no-start` (or `MH_NO_START=1`) renders everything without touching Docker;
`MH_NO_BUILD=1` (or `update --no-build`) reuses the pinned image.

After signup, fill any `changeme` values the CLI lists (`tenants/<id>/.env`
for container env such as the phone gateway credentials, `tenants/<id>/data/.env`
for Hermes' own secrets such as `ANTHROPIC_API_KEY`) and run `apply <id>`.
`ANTHROPIC_API_KEY` and `HERMES_TELEMETRY_TOKEN` are inherited from the
control plane's environment at render time when set.

## What a tenant is

Each tenant is one container from the `image/` recipe:

- **Upstream `nousresearch/hermes-agent`** with its s6-supervised gateway,
  `/opt/data` volume (`$HERMES_HOME`) and privilege drop to the `hermes` user
  (remapped to the control plane's uid so files on the bind mount stay yours).
- **A virtual display + headful Chromium.** The upstream image only ships
  Playwright's headless shell; `image/Dockerfile` adds the full Chromium build
  from the same Playwright pin, fonts, and an s6 service running `Xvfb :99`.
  The agent's built-in browser tools (agent-browser) launch headed on that
  display with `--no-sandbox` — exactly how the OpenClaw fleet's containers
  browse. Verified: as the unprivileged `hermes` user under `cap_drop: ALL` +
  `no-new-privileges`, `agent-browser --headed open https://example.com` opens
  a 945×1060 "Google Chrome for Testing" window on `:99`.
- **OpenAI-compatible API server** (container 8642 → host `127.0.0.1:<port>`,
  ports from 28001). The Rocket.Chat bridge speaks to it with a stable
  `X-Hermes-Session-Id` per (channel, user), so each person keeps one
  continuous conversation.
- **Webhook listener** (container 8644 → host `127.0.0.1:<port+1000>` and the
  tailnet address). The phone gateway wakes the worker here
  (`POST /webhooks/phone`, plain-secret `X-Gitlab-Token` auth, which Hermes'
  adapter validates natively).
- **`hermes-telemetry`** as an s6 service (self-updating `npx @latest` every
  24h), gated on `HERMES_TELEMETRY_TOKEN`, posting to
  `https://8examples.com/hermes/telemetry`.
- **A managed heartbeat** — a Hermes cron job (`managed-heartbeat`, every 4h
  at a per-tenant minute) created through the worker's own CLI at first
  start. It runs `workspace/HEARTBEAT.md`: commitments, capability inboxes,
  nudges, weekly wins. Proactive messages go through `data/outbox/`, which
  the bridge relays into the person's channel — no chat credentials in the
  container.

Resource caps: 3 GB / 1.5 CPU / 768 pids per tenant by default
(`src/provisioner/resources.ts`; website building raises memory to 4 GB).
The fleet box had ~7 GB free alongside 100 OpenClaw containers when this was
written, so plan the first five Hermes workers against that, not against the
caps.

## The three product ideas, and where they live

**1. Per-tenant capabilities** — `src/capabilities/registry.ts`.
Each capability (email, calendar, sms, phone, webdev, paperwork) declares a
`configPatch` deep-merged into that tenant's `config.yaml` when enabled, the
secrets it needs (container env and/or Hermes `.env`), a `workspaceDoc` of
operating rules the agent gets (`data/workspace/capabilities/<id>.md`), and its
own offer/deepen nudge copy. Adding a capability = adding one entry to that
file. `paperwork` is on by default. `phone` is the interesting one: it renders
a `platforms.webhook` route with a generated secret and the full phone-gateway
contract doc from the OpenClaw fleet.

**2. Nudging / habit building** — `src/nudges/engine.ts` + the workspace
templates. Same engine as the OpenClaw fleet: at most one nudge per tenant per
day, offers first, then deepen, with cooldowns; appended to
`data/workspace/nudges/PENDING.md`. The managed heartbeat cron job delivers
them conversationally (via the outbox) and moves them to `DELIVERED.md`. The
`offload-radar` skill (installed into `data/skills/`) covers the reactive side.

**3. Everyone on the newest version** — `src/ops.ts#updateFleet`.
CI (`.github/workflows/deploy.yml`, on every push and nightly) builds
`image/` on the newest upstream Hermes release and pushes
`ghcr.io/8exgh/hermes-8examples`; `npm run cli -- update` pulls it, pins the
digest, re-renders every tenant from the newest templates, and
rolling-restarts the containers (`MH_BUILD_LOCAL=1` builds the image on the
box instead — development only; the fleet box's egress is too slow for the
Chromium download). The "managed
version" is a hash of templates + image recipe + code version, so
`list`/`status` show exactly who is behind. New signups always provision on the
current release. Run it from cron or the deploy workflow.

## What's managed vs. owned per tenant

| Path in `tenants/<id>/` | On re-render/update |
| --- | --- |
| `docker-compose.yml`, `data/config.yaml` | overwritten (managed) |
| `data/workspace/AGENTS.md`, `HEARTBEAT.md`, `capabilities/`, `data/skills/offload-radar/` | overwritten (managed) |
| `.env`, `data/.env` | merged — filled values always preserved |
| `data/SOUL.md` | seeded once, then the tenant's/agent's own |
| `data/skills/*` (bundled + agent-created), `memories/`, `sessions/`, `state.db`, `cron/`, `outbox/`, `workspace/nudges/`, everything else | never touched |

`data/config.yaml` being managed means `hermes config set` / dashboard edits
inside a tenant do not survive the next apply — put durable per-tenant
changes in `tenant.resources`/capabilities, or extend the renderer.

## Rocket.Chat, phone, website, mailbox

- `rocketchat/` — provisioner for `hermes1..hermesN` users/channels, the
  `hermes-bridge` bot, and the bridge service (port 8091 on the fleet box).
- Phone: enable the capability, fill `PHONE_GATEWAY_URL` /
  `PHONE_GATEWAY_API_KEY` in `tenants/<id>/.env`, and register the wake-up
  hook with the gateway (`devops` does this: `provision-openclaw-phone.yml` /
  `enable-claw-capability.yml` branch on the `hermes` prefix and post
  `{url: http://<tailnet>:<hookPort>/webhooks/phone, headers: {X-Gitlab-Token: WEBHOOK_PHONE_SECRET}}`
  to `/notify-config`).
- Website: `scripts/site-sync.sh` (2-minute cron) pushes worker commits from
  `data/workspace/<site>/`; the `issue-claw-website` workflow wires the repo.
- Mailbox: `issue-claw-mailbox` writes `data/workspace/mailboxes/*.md` and
  enables the `email` capability.

## Honest starting-point caveats

- **Approvals are off.** `HERMES_YOLO_MODE=1` in every container: API-server
  and webhook sessions have no human to approve dangerous commands, and the
  container is the sandbox (same posture as the OpenClaw fleet). Revisit if a
  tenant's worker is ever given host-level access.
- **State is JSON on disk** (`data/`), tenants are directories, containers
  run on one host — fine for dozens of tenants; the compute ceiling arrives
  first.
- **Secrets live in `.env` files** (mode 0600, tenant dirs 0700) on the host
  and inside the bind-mounted data dir. The operator and host are trusted by
  every tenant.
- **Browser sandboxing**: Chromium runs `--no-sandbox` because `cap_drop: ALL`
  leaves its own sandbox nothing to use. The container is the isolation
  boundary; untrusted-web workloads deserve gVisor/Kata or a VM tier.
- **Model & credentials**: `anthropic/claude-opus-4-8` by default
  (`HERMES_FLEET_MODEL` / `HERMES_FLEET_PROVIDER` at render time), with
  `cron.model` pinned so the heartbeat never trips Hermes' model-drift guard.
  Anthropic authenticates with a Claude Code **setup-token**
  (`ANTHROPIC_TOKEN`, `sk-ant-oat01-…`) — the same credential the OpenClaw
  fleet uses — passed as `HERMES_ANTHROPIC_TOKEN` / `HERMES_ANTHROPIC_TOKEN_2`
  (or a comma list in `HERMES_ANTHROPIC_TOKENS`) and **rotated across tenants**
  so multiple Claude accounts share the load; a plain `ANTHROPIC_API_KEY`
  works too. When `HERMES_KIMI_API_KEY` is set, `kimi-coding/k3` is rendered as
  a `fallback_providers` entry so a rate-limited or down Anthropic account
  fails over instead of dropping the session.

## Deploying

The fleet box's runner is registered to the `devops` repo, so the rollout
lives there: `devops/.github/workflows/deploy-managed-hermes-fleet.yml`
clones/updates `~/managed-hermes` on the box, creates `hermes1..hermes5` if
missing, builds the image, rolls the fleet with `hermes1` as canary,
(re)registers phone hooks for phone-enabled tenants, and installs/refreshes
the Rocket.Chat bridge (`/etc/hermes/rc-bridge.env` + systemd unit + ufw).
`.github/workflows/deploy.yml` here builds and pushes the image to ghcr on
every push to `main` (and nightly, so the fleet tracks upstream Hermes), then
dispatches that workflow (secret `DEPLOY_TOKEN`, also used for the ghcr push). Rocket.Chat users/channels come from
`devops/.github/workflows/provision-rocketchat-hermes.yml`.

## Suggested cron

```cron
0 * * * *    cd ~/managed-hermes && npm run cli -- nudge
0 5 * * *    cd ~/managed-hermes && npm run cli -- update --canary hermes1
*/2 * * * *  bash ~/managed-hermes/scripts/site-sync.sh >> ~/managed-hermes/site-sync.log 2>&1
```
