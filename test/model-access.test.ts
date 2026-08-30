import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = {
  image: 'test/hermes',
  baseImage: 'test/base',
  nextPort: 1,
};

function tenant(id: string, modelAccess?: 'assigned' | 'suppressed'): Tenant {
  return {
    id,
    name: id,
    contact: {},
    channel: 'rocketchat',
    gatewayPort: 39991,
    hookPort: 40991,
    tier: 'container',
    createdAt: new Date().toISOString(),
    modelAccess,
    capabilities: {},
    nudgeLog: [],
  };
}

test('unassigned Hermes workers receive no model credentials', () => {
  const id = `test-suppressed-${Date.now()}`;
  const dir = path.join(process.cwd(), 'tenants', id);
  try {
    process.env.HERMES_ANTHROPIC_TOKEN = 'anthropic-token';
    process.env.HERMES_KIMI_API_KEY = 'kimi-token';
    renderTenant(tenant(id, 'suppressed'), fleet);
    const env = readFileSync(path.join(dir, 'data', '.env'), 'utf8');
    assert.doesNotMatch(env, /ANTHROPIC_TOKEN|ANTHROPIC_API_KEY|KIMI_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assigned and legacy Hermes workers retain model credentials', () => {
  for (const state of ['assigned', undefined] as const) {
    const id = `test-assigned-${state ?? 'legacy'}-${Date.now()}`;
    const dir = path.join(process.cwd(), 'tenants', id);
    try {
      process.env.HERMES_ANTHROPIC_TOKEN = 'anthropic-token';
      process.env.HERMES_KIMI_API_KEY = 'kimi-token';
      renderTenant(tenant(id, state), fleet);
      const env = readFileSync(path.join(dir, 'data', '.env'), 'utf8');
      assert.match(env, /ANTHROPIC_TOKEN=anthropic-token/);
      assert.match(env, /KIMI_API_KEY=kimi-token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('suppression escrows Hermes credentials and assignment restores them', () => {
  const id = `test-restore-${Date.now()}`;
  const dir = path.join(process.cwd(), 'tenants', id);
  const worker = tenant(id);
  try {
    process.env.HERMES_ANTHROPIC_TOKEN = 'anthropic-existing';
    process.env.HERMES_KIMI_API_KEY = 'kimi-existing';
    renderTenant(worker, fleet);
    worker.modelAccess = 'suppressed';
    renderTenant(worker, fleet);
    assert.doesNotMatch(readFileSync(path.join(dir, 'data', '.env'), 'utf8'), /ANTHROPIC_TOKEN|KIMI_API_KEY/);
    assert.match(readFileSync(path.join(dir, '.model-credentials.env'), 'utf8'), /ANTHROPIC_TOKEN=anthropic-existing/);

    delete process.env.HERMES_ANTHROPIC_TOKEN;
    delete process.env.HERMES_KIMI_API_KEY;
    worker.modelAccess = 'assigned';
    renderTenant(worker, fleet);
    const restored = readFileSync(path.join(dir, 'data', '.env'), 'utf8');
    assert.match(restored, /ANTHROPIC_TOKEN=anthropic-existing/);
    assert.match(restored, /KIMI_API_KEY=kimi-existing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
