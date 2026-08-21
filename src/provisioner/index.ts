import type { Fleet, Tenant, Tier } from '../types.js';
import {
  composeDown,
  composeUp,
  containerStatus,
  dockerAvailable,
  ensureHeartbeatJob,
} from './docker.js';
import { heartbeatSchedule, renderTenant } from './render.js';

export interface ApplyOutcome {
  started: boolean;
  /** Env keys still holding placeholder values after render. */
  missingEnv: string[];
  /** True when the managed heartbeat cron job was created on this apply. */
  heartbeatCreated: boolean;
}

export interface Provisioner {
  apply(tenant: Tenant, fleet: Fleet, opts: { start: boolean }): ApplyOutcome;
  status(tenant: Tenant): string;
  teardown(tenant: Tenant): void;
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const containerProvisioner: Provisioner = {
  apply(tenant, fleet, { start }) {
    const missingEnv = renderTenant(tenant, fleet);
    let started = false;
    let heartbeatCreated = false;
    if (start && dockerAvailable()) {
      composeUp(tenant);
      started = true;
      // The cron CLI needs the gateway's data dir settled; a fresh container
      // takes a few seconds to run its stage2 bootstrap.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          heartbeatCreated = ensureHeartbeatJob(tenant, heartbeatSchedule(tenant.id));
          break;
        } catch (err) {
          if (attempt === 5) {
            console.warn(`  heartbeat job not created for ${tenant.id}: ${(err as Error).message.split('\n')[0]}`);
          } else {
            sleep(5000);
          }
        }
      }
    }
    return { started, missingEnv, heartbeatCreated };
  },
  status: (tenant) => containerStatus(tenant),
  teardown(tenant) {
    if (dockerAvailable()) composeDown(tenant);
  },
};

export function getProvisioner(_tier: Tier | undefined): Provisioner {
  return containerProvisioner;
}
