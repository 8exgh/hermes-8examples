import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderTenant } from '../src/provisioner/render.js';
import type { Fleet, Tenant } from '../src/types.js';

const fleet: Fleet = { image: 'test/hermes', baseImage: 'test/base', nextPort: 1 };

function tenant(id: string): Tenant {
  return {
    id, name: id, contact: {}, channel: 'rocketchat', gatewayPort: 39992, hookPort: 40992,
    tier: 'container', createdAt: new Date().toISOString(), modelAccess: 'assigned',
    capabilities: { email: { enabled: true, enabledAt: new Date().toISOString() } }, nudgeLog: [],
  };
}

test('provisioned mailbox addresses are named in the always-loaded AGENTS.md', () => {
  const id = `test-mailbox-${Date.now()}`;
  const dir = path.join(process.cwd(), 'tenants', id);
  const workspace = path.join(dir, 'data', 'workspace');
  const agents = path.join(workspace, 'AGENTS.md');
  try {
    // No mailbox yet: the email line names no accounts.
    renderTenant(tenant(id), fleet);
    assert.ok(!readFileSync(agents, 'utf8').includes('Live mailboxes'), 'no block before provisioning');

    // The mailbox is delivered into the workspace out-of-band (issue-claw-mailbox).
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      path.join(workspace, 'mailbox.md'),
      '- hermes3@fusenv.com: mailboxes/hermes3_fusenv_com.md\n' +
      '- ops@acme.com: mailboxes/ops_acme_com.md\n',
    );

    // Next render names the live addresses in AGENTS.md.
    renderTenant(tenant(id), fleet);
    const md = readFileSync(agents, 'utf8');
    assert.match(md, /Live mailboxes already connected/);
    assert.match(md, /hermes3@fusenv\.com/);
    assert.match(md, /ops@acme\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
