import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, capability } from './capabilities/registry.js';
import { deliverToWorkspace, pickNudge } from './nudges/engine.js';
import { buildFleetImage, containerStatus, dockerAvailable, imageExists, pullFleetImage } from './provisioner/docker.js';
import { getProvisioner } from './provisioner/index.js';
import { managedVersion, MODEL_CREDENTIAL_KEYS } from './provisioner/render.js';
import {
  HOOK_PORT_OFFSET,
  TENANTS_DIR,
  getTenant,
  loadFleet,
  loadTenants,
  saveFleet,
  saveTenants,
  slugify,
  tenantDataDir,
  tenantDir,
  upsertTenant,
} from './store.js';
import type { CapabilityId, ChannelId, NudgeRecord, Tenant } from './types.js';

export interface SignupInput {
  name: string;
  /** Explicit tenant id; otherwise derived from name. */
  id?: string;
  phone?: string;
  email?: string;
  channel?: ChannelId;
  /** Capabilities to switch on at signup, beyond the defaults. */
  enable?: CapabilityId[];
}

export interface ApplyResult {
  tenant: Tenant;
  missingEnv: string[];
  started: boolean;
  heartbeatCreated: boolean;
}

/** Tenants that participate in rollouts, nudging, and billing. */
export function activeTenants(): Tenant[] {
  return loadTenants().filter((t) => !t.offboardedAt);
}

/** Render the tenant to disk on the current fleet release and (re)start its runtime. */
export function applyTenant(tenant: Tenant, opts: { start?: boolean } = {}): ApplyResult {
  const fleet = loadFleet();
  const requestedStart = opts.start !== false && process.env.MH_NO_START !== '1';
  const wantStart = requestedStart && tenant.modelAccess !== 'suppressed';
  const { started, missingEnv, heartbeatCreated } = getProvisioner(tenant.tier).apply(tenant, fleet, {
    start: wantStart,
  });

  tenant.applied = {
    imageRef: fleet.pinnedImageRef ?? fleet.image,
    managedVersion: managedVersion(),
    appliedAt: new Date().toISOString(),
  };
  upsertTenant(tenant);
  if (tenant.modelAccess === 'suppressed' && requestedStart) {
    getProvisioner(tenant.tier).teardown(tenant);
  }
  return { tenant, missingEnv, started, heartbeatCreated };
}

export function signup(input: SignupInput, opts: { start?: boolean } = {}): ApplyResult {
  const fleet = loadFleet();
  const now = new Date().toISOString();

  const gatewayPort = fleet.freePorts?.length ? fleet.freePorts.shift()! : fleet.nextPort++;

  const id = input.id ?? slugify(input.name);
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) {
    throw new Error(`Tenant id must be lowercase letters, digits and dashes: ${id}`);
  }
  if (loadTenants().some((t) => t.id === id)) {
    throw new Error(`Tenant id already taken: ${id}`);
  }

  const tenant: Tenant = {
    id,
    name: input.name,
    contact: { phone: input.phone, email: input.email },
    channel: input.channel ?? 'rocketchat',
    tier: 'container',
    gatewayPort,
    hookPort: gatewayPort + HOOK_PORT_OFFSET,
    createdAt: now,
    modelAccess: 'suppressed',
    capabilities: {},
    nudgeLog: [],
  };
  saveFleet(fleet);

  for (const def of CAPABILITIES) {
    const enable = def.defaultEnabled || (input.enable ?? []).includes(def.id);
    tenant.capabilities[def.id] = enable
      ? { enabled: true, enabledAt: now }
      : { enabled: false };
  }
  upsertTenant(tenant);

  // Day-one nudge so the assistant starts selling the next capability immediately.
  runNudge(tenant);

  return applyTenant(tenant, opts);
}

export function setModelAccess(tenantId: string, assigned: boolean, opts: { start?: boolean } = {}): ApplyResult {
  const tenant = getTenant(tenantId);
  tenant.modelAccess = assigned ? 'assigned' : 'suppressed';
  upsertTenant(tenant);
  return applyTenant(tenant, opts);
}

/** Sync desired assignment against actual credentials and container state. */
export function syncModelAccess(assignedIds: ReadonlySet<string>): { assigned: number; suppressed: number; changed: string[] } {
  const tenants = loadTenants();
  let assigned = 0;
  let suppressed = 0;
  const changed: string[] = [];
  for (const tenant of tenants) {
    if (tenant.offboardedAt) continue;
    const next = assignedIds.has(tenant.id) ? 'assigned' : 'suppressed';
    const file = path.join(tenantDataDir(tenant.id), '.env');
    const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const hasRealCredential = MODEL_CREDENTIAL_KEYS.some((key) => {
      const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
      return Boolean(match?.[1] && match[1] !== 'changeme');
    });
    const credentialsMatch = next === 'assigned' ? hasRealCredential : !hasRealCredential;
    const status = containerStatus(tenant);
    const runtimeMatch = next === 'assigned'
      ? /\bUp\b/i.test(status) && !/Restarting/i.test(status)
      : status === 'not created' || /\bExited\b/i.test(status);
    if (!credentialsMatch || !runtimeMatch) changed.push(tenant.id);
    tenant.modelAccess = next;
    if (next === 'assigned') assigned += 1;
    else suppressed += 1;
  }
  saveTenants(tenants);
  return { assigned, suppressed, changed };
}

export function setCapability(
  tenantId: string,
  capabilityId: CapabilityId,
  enabled: boolean,
  opts: { start?: boolean } = {},
): ApplyResult {
  const tenant = getTenant(tenantId);
  capability(capabilityId); // validates id
  const prev = tenant.capabilities[capabilityId];
  tenant.capabilities[capabilityId] = enabled
    ? { enabled: true, enabledAt: prev?.enabledAt ?? new Date().toISOString() }
    : { enabled: false };
  upsertTenant(tenant);
  return applyTenant(tenant, opts);
}

/** Run the nudge engine for one tenant; writes into its workspace when a nudge fires. */
export function runNudge(tenant: Tenant): NudgeRecord | null {
  const nudge = pickNudge(tenant);
  if (!nudge) return null;
  tenant.nudgeLog.push(nudge);
  upsertTenant(tenant);
  deliverToWorkspace(tenant, nudge);
  return nudge;
}

export function runNudgesAll(): { tenant: string; nudge: NudgeRecord | null }[] {
  return activeTenants().map((t) => ({ tenant: t.id, nudge: runNudge(t) }));
}

export interface UpdateResult {
  imageRef: string;
  previousImageRef?: string;
  managedVersion: string;
  tenants: { id: string; started: boolean; missingEnv: string[] }[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A tenant is healthy when its runtime reports an up-and-not-restarting state. */
async function waitHealthy(tenant: Tenant, attempts = 6, gapMs = 5000): Promise<boolean> {
  const provisioner = getProvisioner(tenant.tier);
  for (let i = 0; i < attempts; i++) {
    await sleep(gapMs);
    const status = provisioner.status(tenant);
    if (status.startsWith('Up') && !status.includes('Restarting')) return true;
  }
  return false;
}

/**
 * Fleet update: pull the newest CI-built fleet image (or, with
 * MH_BUILD_LOCAL=1, build it here on the newest upstream Hermes), pin it,
 * then re-render every active tenant on the newest managed templates and
 * rolling-restart them. With `canary`, that tenant is updated first and must
 * pass a health check before the rollout continues — run your own instance
 * as tenant zero.
 */
export async function updateFleet(
  opts: { start?: boolean; canary?: string; build?: boolean } = {},
): Promise<UpdateResult> {
  const fleet = loadFleet();

  if (dockerAvailable() && opts.build !== false && process.env.MH_NO_BUILD !== '1') {
    const next =
      process.env.MH_BUILD_LOCAL === '1'
        ? buildFleetImage(fleet.image, fleet.baseImage)
        : pullFleetImage(fleet.image);
    if (fleet.pinnedImageRef && fleet.pinnedImageRef !== next) {
      fleet.previousImageRef = fleet.pinnedImageRef;
    }
    fleet.pinnedImageRef = next;
  } else if (fleet.pinnedImageRef && dockerAvailable() && !imageExists(fleet.pinnedImageRef)) {
    throw new Error(`Pinned image ${fleet.pinnedImageRef} is not present locally; run update without --no-build`);
  }
  saveFleet(fleet);

  const all = activeTenants();
  if (opts.canary && !all.some((t) => t.id === opts.canary)) {
    throw new Error(`Canary tenant not found or offboarded: ${opts.canary}`);
  }
  const order = opts.canary
    ? [...all.filter((t) => t.id === opts.canary), ...all.filter((t) => t.id !== opts.canary)]
    : all;

  const tenants: UpdateResult['tenants'] = [];
  for (let i = 0; i < order.length; i++) {
    const tenant = order[i];
    const result = applyTenant(tenant, opts);
    tenants.push({ id: tenant.id, started: result.started, missingEnv: result.missingEnv });

    if (i === 0 && opts.canary && result.started && !(await waitHealthy(tenant))) {
      throw new Error(
        `Canary ${tenant.id} unhealthy on ${fleet.pinnedImageRef ?? fleet.image} — rollout halted` +
          (fleet.previousImageRef ? ` (previous release: ${fleet.previousImageRef})` : ''),
      );
    }
  }

  return {
    imageRef: fleet.pinnedImageRef ?? fleet.image,
    previousImageRef: fleet.previousImageRef,
    managedVersion: managedVersion(),
    tenants,
  };
}

/**
 * Offboarding: stop the runtime, mark the tenant inactive, reclaim the port.
 * With `purge`, also delete the tenant directory (config, workspace, secrets,
 * memories) and the stored record including contact info — the PIPEDA
 * deletion path.
 */
export function offboardTenant(
  tenantId: string,
  opts: { purge?: boolean } = {},
): { tenant: string; purged: boolean } {
  const tenant = getTenant(tenantId);
  if (tenant.offboardedAt && !opts.purge) {
    return { tenant: tenant.id, purged: false };
  }

  getProvisioner(tenant.tier).teardown(tenant);

  const fleet = loadFleet();
  if (!fleet.freePorts?.includes(tenant.gatewayPort) && !tenant.offboardedAt) {
    fleet.freePorts = [...(fleet.freePorts ?? []), tenant.gatewayPort];
    saveFleet(fleet);
  }

  let purged = false;
  if (opts.purge) {
    // Containment: never delete outside the tenants directory.
    const dir = path.resolve(tenantDir(tenant.id));
    if (!dir.startsWith(path.resolve(TENANTS_DIR) + path.sep)) {
      throw new Error(`Refusing to purge path outside tenants dir: ${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
    saveTenants(loadTenants().filter((t) => t.id !== tenant.id));
    purged = true;
  } else {
    tenant.offboardedAt = new Date().toISOString();
    upsertTenant(tenant);
  }

  return { tenant: tenant.id, purged };
}

export interface TenantSummary {
  id: string;
  name: string;
  channel: ChannelId;
  gatewayPort: number;
  hookPort: number;
  container: string;
  capabilities: Record<string, boolean>;
  managedVersion?: string;
  upToDate: boolean;
  nudges: number;
  offboarded: boolean;
}

export function summarize(tenant: Tenant): TenantSummary {
  const current = managedVersion();
  return {
    id: tenant.id,
    name: tenant.name,
    channel: tenant.channel,
    gatewayPort: tenant.gatewayPort,
    hookPort: tenant.hookPort,
    container: getProvisioner(tenant.tier).status(tenant),
    capabilities: Object.fromEntries(
      Object.entries(tenant.capabilities).map(([id, s]) => [id, !!s?.enabled]),
    ),
    managedVersion: tenant.applied?.managedVersion,
    upToDate: tenant.applied?.managedVersion === current,
    nudges: tenant.nudgeLog.length,
    offboarded: !!tenant.offboardedAt,
  };
}
