import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { IMAGE_DIR, tenantDataDir, tenantDir } from '../store.js';
import type { Tenant } from '../types.js';

export function containerName(tenant: Tenant | string): string {
  return `hermes-${typeof tenant === 'string' ? tenant : tenant.id}`;
}

function docker(args: string[], cwd?: string): string {
  return execFileSync('docker', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function dockerAvailable(): boolean {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

export function composeUp(tenant: Tenant): void {
  const dir = tenantDir(tenant.id);
  docker(['compose', 'up', '-d', '--remove-orphans'], dir);
  // A config-only change (config.yaml lives on the bind mount, so the compose
  // file is unchanged) makes `up -d` a no-op. The gateway reads config.yaml
  // at session start but platform/webhook wiring is read at boot, so a full
  // restart guarantees the rendered config is what runs.
  docker(['compose', 'restart'], dir);
}

export function composeDown(tenant: Tenant): void {
  docker(['compose', 'down'], tenantDir(tenant.id));
}

export function containerStatus(tenant: Tenant): string {
  try {
    const out = docker([
      'ps',
      '--all',
      '--filter',
      `name=^${containerName(tenant)}$`,
      '--format',
      '{{.Status}}',
    ]).trim();
    return out || 'not created';
  } catch {
    return 'docker unavailable';
  }
}

/**
 * The fleet image is built here from image/Dockerfile on top of the upstream
 * base. `--pull` fetches the newest upstream, so a fleet update always rides
 * the newest Hermes release. Returns a tag pinned to the build's image id so
 * every tenant runs the identical build until the next update.
 */
export function buildFleetImage(image: string, baseImage: string): string {
  // Pull the upstream base with retries first: the fleet box's egress has
  // dropped mid-pull on Docker Hub's CDN before ("read: connection timed
  // out"), and one blip must not fail a whole rollout. Docker resumes the
  // layers it already has, so a retry is cheap.
  let pulled = false;
  for (let attempt = 1; attempt <= 4 && !pulled; attempt++) {
    try {
      execFileSync('docker', ['pull', baseImage], { stdio: 'inherit' });
      pulled = true;
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`docker pull ${baseImage} failed (attempt ${attempt}); retrying in ${attempt * 15}s`);
      execFileSync('sleep', [String(attempt * 15)]);
    }
  }
  execFileSync(
    'docker',
    ['build', '--build-arg', `HERMES_BASE=${baseImage}`, '-t', image, IMAGE_DIR],
    { stdio: 'inherit' },
  );
  const id = docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim();
  const short = id.replace(/^sha256:/, '').slice(0, 12);
  const repo = image.split(':')[0];
  const pinned = `${repo}:build-${short}`;
  docker(['tag', image, pinned]);
  return pinned;
}

/** Pull the CI-built fleet image (with retries) and return its digest-pinned ref. */
export function pullFleetImage(image: string): string {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync('docker', ['pull', image], { stdio: 'inherit' });
      break;
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`docker pull ${image} failed (attempt ${attempt}); retrying in ${attempt * 15}s`);
      execFileSync('sleep', [String(attempt * 15)]);
    }
  }
  return resolveDigest(image) ?? image;
}

/** Resolve the digest-pinned ref for an image so the whole fleet runs one build. */
export function resolveDigest(image: string): string | undefined {
  try {
    const out = docker(['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}']).trim();
    return out && out !== '<no value>' ? out : undefined;
  } catch {
    return undefined;
  }
}

export function imageExists(image: string): boolean {
  try {
    docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The managed heartbeat is a Hermes cron job (the upstream equivalent of
 * OpenClaw's HEARTBEAT.md). It is created through the worker's own CLI so
 * the scheduler owns the entry; presence is checked host-side in the
 * tenant's cron/jobs.json, which the scheduler re-reads every tick.
 */
export const HEARTBEAT_JOB_NAME = 'managed-heartbeat';

export function heartbeatJobExists(tenant: Tenant): boolean {
  const file = path.join(tenantDataDir(tenant.id), 'cron', 'jobs.json');
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const jobs = Array.isArray(parsed)
      ? parsed
      : ((parsed as { jobs?: unknown[] })?.jobs ?? []);
    return jobs.some((j) => (j as { name?: string })?.name === HEARTBEAT_JOB_NAME);
  } catch {
    return false;
  }
}

export function ensureHeartbeatJob(tenant: Tenant, schedule: string): boolean {
  if (heartbeatJobExists(tenant)) return false;
  const prompt =
    'Managed heartbeat. Read /opt/data/workspace/HEARTBEAT.md and do exactly what it says, ' +
    'in order. Your working directory is /opt/data/workspace. If nothing needs doing, reply HEARTBEAT_OK and stop.';
  docker([
    'exec',
    containerName(tenant),
    'hermes',
    'cron',
    'create',
    schedule,
    prompt,
    '--name',
    HEARTBEAT_JOB_NAME,
    '--deliver',
    'local',
    '--workdir',
    '/opt/data/workspace',
  ]);
  return true;
}
