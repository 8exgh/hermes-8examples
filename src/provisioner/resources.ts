import { capability } from '../capabilities/registry.js';
import type { CapabilityId, Tenant } from '../types.js';

export interface Resources {
  memoryGb: number;
  cpus: number;
  pidsLimit: number;
}

/**
 * Floor for a tenant: the Hermes gateway (Python) idles well under 1 GB, but
 * every tenant carries a headful Chromium on its virtual display, and the
 * upstream guidance is 2 GB minimum with browser tools active. 3 GB keeps a
 * busy browsing session from hitting the cgroup ceiling.
 */
const BASE: Resources = { memoryGb: 3, cpus: 1.5, pidsLimit: 768 };

/**
 * Enabled capabilities raise the floor; an explicit `tenant.resources`
 * override always wins (operator knows about a specific heavy tenant).
 */
export function resourcesFor(tenant: Tenant): Resources {
  const out = { ...BASE };

  for (const [id, state] of Object.entries(tenant.capabilities)) {
    if (!state?.enabled) continue;
    const floor = capability(id as CapabilityId).memoryGbFloor;
    if (floor && floor > out.memoryGb) out.memoryGb = floor;
  }

  return { ...out, ...tenant.resources };
}

export const asDockerMem = (gb: number): string => `${gb}g`;
