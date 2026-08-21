import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CAPABILITIES, capability } from '../capabilities/registry.js';
import { IMAGE_DIR, TEMPLATES_DIR, tenantDataDir, tenantDir } from '../store.js';
import type { CapabilityId, Fleet, Tenant } from '../types.js';
import { asDockerMem, resourcesFor } from './resources.js';
import { toYaml, type YamlValue } from './yaml.js';

/**
 * The container remaps its `hermes` user to HERMES_UID/HERMES_GID at boot and
 * chowns the data volume to it, so the data dir must be owned by whoever runs
 * the control plane (uid 1000 = `openclaw` on the fleet host). Running the
 * control plane as root is supported: dirs are handed to CONTAINER_UID.
 */
export const CONTAINER_UID = Number(process.env.HERMES_HOST_UID ?? (process.getuid?.() === 0 ? 1000 : process.getuid?.() ?? 1000));
export const CONTAINER_GID = Number(process.env.HERMES_HOST_GID ?? (process.getgid?.() === 0 ? 1000 : process.getgid?.() ?? 1000));

/** Tailnet address the phone gateway reaches webhook listeners on. */
export const HOOK_BIND_IP = process.env.HERMES_HOOK_BIND_IP ?? '100.97.6.94';

/** Fleet default model/provider; override at render time with HERMES_FLEET_MODEL / HERMES_FLEET_PROVIDER. */
export const FLEET_MODEL = process.env.HERMES_FLEET_MODEL || 'claude-opus-4-8';
export const FLEET_PROVIDER = process.env.HERMES_FLEET_PROVIDER || 'anthropic';

/**
 * The secret each provider reads from $HERMES_HOME/.env (Hermes' own names).
 * Inherited from the control plane's environment at render time; empty or
 * placeholder values are treated as missing so `apply` keeps reporting them.
 */
export const PROVIDER_KEY_ENV: Record<string, string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-api': 'OPENAI_API_KEY', // Hermes' direct-OpenAI provider slug
  openrouter: 'OPENROUTER_API_KEY',
  nous: undefined, // OAuth via `hermes setup --portal` (auth.json), no key
};

function inheritedSecret(key: string | undefined): string {
  if (!key) return '';
  const value = (process.env[key] ?? '').trim();
  return value && value !== 'changeme' ? value : '';
}

function ensureDirForContainer(dir: string, mode = 0o755): void {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
  if (process.getuid?.() === 0) {
    try {
      chownSync(dir, CONTAINER_UID, CONTAINER_GID);
    } catch {
      /* best effort */
    }
  }
}

/** Bump when the managed layer changes in a way not captured by template/image files. */
export const MANAGED_LAYER_VERSION = '0.1.0';

/** Version fingerprint of the managed layer: templates + image recipe + code version. */
export function managedVersion(): string {
  const hash = createHash('sha256');
  hash.update(MANAGED_LAYER_VERSION);
  const walk = (root: string, dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(root, full);
      else {
        hash.update(path.relative(root, full));
        hash.update(readFileSync(full));
      }
    }
  };
  for (const dir of [TEMPLATES_DIR, IMAGE_DIR]) if (existsSync(dir)) walk(path.dirname(dir), dir);
  return `${MANAGED_LAYER_VERSION}+${hash.digest('hex').slice(0, 12)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for config fragments; arrays and scalars are replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function tenantHash(tenantId: string): number {
  let hash = 2166136261;
  for (const char of tenantId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Managed heartbeat cadence: every 4 hours, at a per-tenant minute, so fleet
 * restarts do not leave every worker firing on the same cadence. A crontab
 * expression because `hermes cron create` accepts one verbatim.
 */
export function heartbeatSchedule(tenantId: string): string {
  return `${tenantHash(tenantId) % 60} */4 * * *`;
}

/** Build the tenant's config.yaml: managed base + every enabled capability's patch. */
export function buildHermesConfig(
  tenant: Tenant,
  secrets: Record<string, string>,
): Record<string, unknown> {
  let config: Record<string, unknown> = {
    model: {
      provider: FLEET_PROVIDER,
      default: FLEET_MODEL,
    },
    // Cron jobs (the managed heartbeat) pin the fleet model explicitly, so a
    // later `hermes model` change never trips Hermes' model-drift guard and
    // silently skips the heartbeat.
    cron: {
      model: FLEET_MODEL,
      model_provider: FLEET_PROVIDER,
    },
    terminal: {
      backend: 'local',
      // Gateway + cron working directory: AGENTS.md here is injected into
      // every session's system prompt.
      cwd: '/opt/data/workspace',
      timeout: 180,
    },
    browser: {
      // Built-in browser tools driving the image's headful Chromium through
      // agent-browser on the virtual display. `off` pins that path instead of
      // the browser-use CLI default, which would fetch its own harness at
      // first use.
      backend: 'off',
      headed: true,
      inactivity_timeout: 120,
    },
    session_reset: {
      mode: 'daily',
      at_hour: 4,
    },
    // Unattended gateway: a stuck tool loop must stop, not spend the whole
    // iteration budget (upstream recommends this for server deployments).
    tool_loop_guardrails: {
      warnings_enabled: true,
      hard_stop_enabled: true,
      hard_stop_after: {
        exact_failure: 5,
        same_tool_failure: 8,
        idempotent_no_progress: 5,
      },
    },
    agent: {
      reasoning_effort: 'medium',
    },
    memory: {
      memory_enabled: true,
      user_profile_enabled: true,
    },
  };

  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    config = deepMerge(config, capability(id as CapabilityId).configPatch(tenant, secrets));
  }

  return config;
}

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function readEnvFile(file: string): Map<string, string> {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : new Map<string, string>();
}

function writeEnvFile(file: string, env: Map<string, string>): void {
  const lines = [...env.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  if (process.getuid?.() === 0) {
    try {
      chownSync(file, CONTAINER_UID, CONTAINER_GID);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Container environment (tenants/<id>/.env, compose env_file): things the
 * worker's subprocesses read — the phone gateway credentials, the telemetry
 * token. Preserves filled values; new keys get placeholders.
 */
function renderContainerEnv(tenant: Tenant, dir: string): string[] {
  const file = path.join(dir, '.env');
  const env = readEnvFile(file);
  const ensure = (key: string, value: string): void => {
    if (!env.get(key)) env.set(key, value);
  };

  if (process.env.HERMES_TELEMETRY_TOKEN) ensure('HERMES_TELEMETRY_TOKEN', process.env.HERMES_TELEMETRY_TOKEN);
  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    for (const { key } of capability(id as CapabilityId).env) ensure(key, 'changeme');
  }

  writeEnvFile(file, env);
  return [...env.entries()].filter(([, v]) => v === 'changeme').map(([k]) => k);
}

/**
 * Hermes' own secrets file ($HERMES_HOME/.env, loaded by the gateway with
 * override=True): provider key, API server, webhook, Telegram. Rendered before
 * the first boot so the image's first-boot seeding never writes an example
 * file with empty assignments that would shadow real values.
 */
function renderHermesEnv(tenant: Tenant, dataDir: string, channelReady: boolean): {
  missing: string[];
  secrets: Record<string, string>;
} {
  const file = path.join(dataDir, '.env');
  const env = readEnvFile(file);
  const ensure = (key: string, value: string): void => {
    if (!env.get(key)) env.set(key, value);
  };
  const set = (key: string, value: string): void => {
    env.set(key, value);
  };

  const providerKey = PROVIDER_KEY_ENV[FLEET_PROVIDER];
  if (providerKey) ensure(providerKey, inheritedSecret(providerKey) || 'changeme');

  // The Rocket.Chat bridge speaks to this; loopback-published only.
  set('API_SERVER_ENABLED', 'true');
  set('API_SERVER_HOST', '0.0.0.0');
  set('API_SERVER_MODEL_NAME', tenant.id);
  ensure('API_SERVER_KEY', randomBytes(24).toString('hex'));

  const phone = tenant.capabilities.phone?.enabled === true;
  set('WEBHOOK_ENABLED', phone ? 'true' : 'false');
  if (phone) set('WEBHOOK_PORT', '8644');
  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    for (const def of capability(id as CapabilityId).hermesEnv ?? []) {
      ensure(def.key, def.generate ? def.generate() : 'changeme');
    }
  }

  if (tenant.channel === 'telegram') {
    ensure('TELEGRAM_BOT_TOKEN', 'changeme');
    // Locked to specific peers when telegramAllowFrom is set; otherwise open
    // (the operator's own bots — flag to revert for real customers).
    if (tenant.telegramAllowFrom?.length) {
      set('TELEGRAM_ALLOWED_USERS', tenant.telegramAllowFrom.join(','));
      env.delete('TELEGRAM_ALLOW_ALL_USERS');
    } else {
      set('TELEGRAM_ALLOW_ALL_USERS', 'true');
      env.delete('TELEGRAM_ALLOWED_USERS');
    }
    if (!channelReady) {
      // A placeholder token would make the gateway retry Telegram forever;
      // keep the key present (so the operator sees it) but inert.
      set('TELEGRAM_BOT_TOKEN', env.get('TELEGRAM_BOT_TOKEN') ?? 'changeme');
    }
  } else {
    env.delete('TELEGRAM_BOT_TOKEN');
    env.delete('TELEGRAM_ALLOWED_USERS');
    env.delete('TELEGRAM_ALLOW_ALL_USERS');
  }

  writeEnvFile(file, env);
  const secrets = Object.fromEntries(env.entries());
  return {
    missing: [...env.entries()].filter(([, v]) => v === 'changeme').map(([k]) => k),
    secrets,
  };
}

function template(name: string, vars: Record<string, string>): string {
  const raw = readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

function capabilitySections(tenant: Tenant): { enabled: string; upgrades: string } {
  const enabled: string[] = [];
  const upgrades: string[] = [];
  for (const def of CAPABILITIES.slice().sort((a, b) => a.priority - b.priority)) {
    if (tenant.capabilities[def.id]?.enabled) {
      enabled.push(`- **${def.label}** — ${def.tagline} (details: \`capabilities/${def.id}.md\`)`);
    } else if (def.offerNudges.length > 0) {
      upgrades.push(`- **${def.label}** — ${def.tagline}\n  - Offer line: "${def.offerNudges[0]}"`);
    }
  }
  return {
    enabled: enabled.join('\n') || '- (nothing enabled yet — your job is conversation and paperwork triage)',
    upgrades: upgrades.join('\n') || '- (everything is enabled — focus on deepening usage)',
  };
}

function channelLabel(tenant: Tenant): string {
  return tenant.channel === 'telegram' ? 'Telegram' : 'Rocket.Chat (chat.8examples.com)';
}

/**
 * Render the tenant's full on-disk footprint:
 *
 *   tenants/<id>/
 *     docker-compose.yml          managed (overwritten)
 *     .env                        merged — container env (phone gateway creds, telemetry token)
 *     data/                       $HERMES_HOME (→ /opt/data)
 *       config.yaml               managed (overwritten)
 *       .env                      merged — Hermes secrets (provider key, API server, webhook, Telegram)
 *       SOUL.md                   seeded once, then the tenant's/agent's own
 *       workspace/AGENTS.md       managed (overwritten)
 *       workspace/HEARTBEAT.md    managed (overwritten)
 *       workspace/capabilities/   managed (rebuilt)
 *       skills/offload-radar/     managed (rebuilt; every other skill untouched)
 *       workspace/nudges/, outbox/, memories/, sessions/, cron/, everything else: never touched here
 *
 * Returns env keys (both files) that still hold placeholder values.
 */
export function renderTenant(tenant: Tenant, fleet: Fleet): string[] {
  const dir = tenantDir(tenant.id);
  const dataDir = tenantDataDir(tenant.id);
  const workspace = path.join(dataDir, 'workspace');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700); // holds secrets
  ensureDirForContainer(dataDir);
  ensureDirForContainer(workspace);
  ensureDirForContainer(path.join(dataDir, 'outbox'));
  ensureDirForContainer(path.join(dataDir, 'outbox', 'sent'));
  ensureDirForContainer(path.join(dataDir, 'skills'));

  const imageRef = fleet.pinnedImageRef ?? fleet.image;
  const res = resourcesFor(tenant);

  // Telegram only switches on once a real bot token is in place.
  const existingToken = readEnvFile(path.join(dataDir, '.env')).get('TELEGRAM_BOT_TOKEN');
  const channelReady = !!existingToken && existingToken !== 'changeme';

  const hermesEnv = renderHermesEnv(tenant, dataDir, channelReady);

  const configFile = path.join(dataDir, 'config.yaml');
  writeFileSync(configFile, toYaml(buildHermesConfig(tenant, hermesEnv.secrets) as YamlValue));
  chmodSync(configFile, 0o640);

  writeFileSync(
    path.join(dir, 'docker-compose.yml'),
    template('docker-compose.yml', {
      IMAGE: imageRef,
      TENANT_ID: tenant.id,
      PORT: String(tenant.gatewayPort),
      HOOK_PORT: String(tenant.hookPort),
      HOOK_TAILNET_PORT_LINE:
        HOOK_BIND_IP === '127.0.0.1' || HOOK_BIND_IP === 'localhost'
          ? ''
          : `      - "${HOOK_BIND_IP}:${tenant.hookPort}:8644"\n`,
      HERMES_UID: String(CONTAINER_UID),
      HERMES_GID: String(CONTAINER_GID),
      MEM_LIMIT: asDockerMem(res.memoryGb),
      CPUS: String(res.cpus),
      PIDS_LIMIT: String(res.pidsLimit),
    }),
  );

  const sections = capabilitySections(tenant);
  const vars = {
    NAME: tenant.name,
    TENANT_ID: tenant.id,
    CHANNEL: channelLabel(tenant),
    ENABLED_CAPABILITIES: sections.enabled,
    UPGRADE_CAPABILITIES: sections.upgrades,
    MANAGED_VERSION: managedVersion(),
  };

  writeFileSync(path.join(workspace, 'AGENTS.md'), template('workspace/AGENTS.md', vars));
  writeFileSync(path.join(workspace, 'HEARTBEAT.md'), template('workspace/HEARTBEAT.md', vars));

  const soul = path.join(dataDir, 'SOUL.md');
  if (!existsSync(soul)) writeFileSync(soul, template('workspace/SOUL.md', vars));

  // Only our managed skill is rebuilt; Hermes' bundled + agent-created skills
  // share the same directory and must survive renders.
  const offloadDir = path.join(dataDir, 'skills', 'offload-radar');
  rmSync(offloadDir, { recursive: true, force: true });
  mkdirSync(offloadDir, { recursive: true });
  writeFileSync(
    path.join(offloadDir, 'SKILL.md'),
    template('workspace/skills/offload-radar/SKILL.md', vars),
  );

  const capsDir = path.join(workspace, 'capabilities');
  rmSync(capsDir, { recursive: true, force: true });
  mkdirSync(capsDir, { recursive: true });
  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    writeFileSync(path.join(capsDir, `${id}.md`), capability(id as CapabilityId).workspaceDoc);
  }

  const nudgesDir = path.join(workspace, 'nudges');
  mkdirSync(nudgesDir, { recursive: true });
  const delivered = path.join(nudgesDir, 'DELIVERED.md');
  if (!existsSync(delivered)) writeFileSync(delivered, '# Delivered nudges\n\n');

  const missingContainerEnv = renderContainerEnv(tenant, dir);
  return [...hermesEnv.missing, ...missingContainerEnv];
}
