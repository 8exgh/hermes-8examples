import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fleet, Tenant } from './types.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const TENANTS_DIR = path.join(ROOT, 'tenants');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const IMAGE_DIR = path.join(ROOT, 'image');

const FLEET_FILE = path.join(DATA_DIR, 'fleet.json');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');

/** API-server ports start here; each tenant's webhook port is +HOOK_PORT_OFFSET. */
export const FIRST_PORT = 28001;
export const HOOK_PORT_OFFSET = 1000;

/** Built by .github/workflows/deploy.yml in CI and pulled here; local builds use MH_BUILD_LOCAL=1. */
export const DEFAULT_IMAGE = 'ghcr.io/8exgh/hermes-8examples:latest';
/** The pre-registry default; fleets rendered with it are moved to DEFAULT_IMAGE on load. */
const LEGACY_LOCAL_IMAGE = 'hermes-8examples:latest';

const DEFAULT_FLEET: Fleet = {
  image: DEFAULT_IMAGE,
  baseImage: 'nousresearch/hermes-agent:latest',
  nextPort: FIRST_PORT,
};

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadFleet(): Fleet {
  const fleet = { ...DEFAULT_FLEET, ...readJson<Partial<Fleet>>(FLEET_FILE, {}) };
  if (fleet.image === LEGACY_LOCAL_IMAGE && process.env.MH_BUILD_LOCAL !== '1') fleet.image = DEFAULT_IMAGE;
  return fleet;
}

export function saveFleet(fleet: Fleet): void {
  writeJson(FLEET_FILE, fleet);
}

export function loadTenants(): Tenant[] {
  return readJson<Tenant[]>(TENANTS_FILE, []);
}

export function saveTenants(tenants: Tenant[]): void {
  writeJson(TENANTS_FILE, tenants);
}

export function getTenant(id: string): Tenant {
  const tenant = loadTenants().find((t) => t.id === id);
  if (!tenant) throw new Error(`Unknown tenant: ${id}`);
  return tenant;
}

export function upsertTenant(tenant: Tenant): void {
  const tenants = loadTenants();
  const i = tenants.findIndex((t) => t.id === tenant.id);
  if (i >= 0) tenants[i] = tenant;
  else tenants.push(tenant);
  saveTenants(tenants);
}

export function tenantDir(id: string): string {
  return path.join(TENANTS_DIR, id);
}

/** The tenant's Hermes home ($HERMES_HOME, mounted at /opt/data in the container). */
export function tenantDataDir(id: string): string {
  return path.join(tenantDir(id), 'data');
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'tenant';
  const taken = new Set(loadTenants().map((t) => t.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
