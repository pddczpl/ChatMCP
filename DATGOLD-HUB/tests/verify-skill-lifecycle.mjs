import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginManager } from '../lib/plugins.mjs';
import { GitHubSkillRegistry } from '../lib/skill-registry.mjs';

test('registry lifecycle persists install, toggle, update and uninstall across reloads', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-skill-lifecycle-'));
  let revision = 'a'.repeat(40);
  // Exercise the real managers with a deterministic GitHub transport, including
  // the legacy contents endpoint whose update flag previously got dropped.
  const transport = async (url) => {
    if (url.endsWith('/commits/HEAD')) return { text: JSON.stringify({ sha: revision }) };
    if (url.includes('/contents/skills?ref=')) return { text: JSON.stringify([{ type: 'dir', path: 'skills/lifecycle' }]) };
    if (url.includes('/contents/skills/lifecycle?ref=')) return { text: '[]' };
    if (url.endsWith('/skills/lifecycle/SKILL.md')) return { text: `---\nname: lifecycle\ndescription: Lifecycle test\n---\nInstructions at ${revision}.` };
    throw Error(`Unexpected fixture URL: ${url}`);
  };
  const reload = async () => {
    const plugins = new PluginManager({ stateDir });
    await plugins.load();
    const registry = new GitHubSkillRegistry({ pluginManager: plugins, stateDir, transport });
    await registry.load();
    return { plugins, registry };
  };
  try {
    let { plugins, registry } = await reload();
    await registry.refresh({ sourceId: 'anthropic' });
    const entry = registry.list()[0];
    const imported = await registry.install({ key: entry.key });
    assert.equal(imported.enabled, false, 'registry install must remain disabled until enabled');
    assert.equal(imported.id, entry.id, 'discovery and installed IDs must match for UI join');
    assert.equal(plugins.marketplace().some((skill) => skill.id === imported.id), false, 'marketplace alone cannot supply registry lifecycle state');
    assert.equal(plugins.installed().find((skill) => skill.id === entry.id)?.enabled, false);
    await assert.rejects(registry.install({ key: entry.key }), { code: 'already_installed' });

    ({ plugins, registry } = await reload());
    assert.equal(plugins.installed().find((skill) => skill.id === entry.id)?.enabled, false);
    await plugins.toggle(entry.id, true);
    ({ plugins, registry } = await reload());
    assert.equal(plugins.installed().find((skill) => skill.id === entry.id)?.enabled, true);

    revision = 'b'.repeat(40);
    await registry.refresh({ sourceId: 'anthropic' });
    assert.equal(registry.updates()[0].key, entry.key);
    const updated = await registry.install({ key: entry.key, update: true });
    assert.equal(updated.commitSha, revision);
    assert.equal(updated.enabled, false, 'updated third-party instructions require re-enabling');
    assert.equal(registry.updates().length, 0);
    ({ plugins, registry } = await reload());
    assert.equal(plugins.installed().find((skill) => skill.id === entry.id)?.commitSha, revision);
    await plugins.uninstall(entry.id);
    ({ plugins, registry } = await reload());
    assert.equal(plugins.installed().some((skill) => skill.id === entry.id), false);
    assert.equal(registry.list()[0].id, entry.id, 'uninstalled skill remains discoverable');
    assert.equal(registry.updates().length, 0);
    await registry.install({ key: entry.key });
    assert.equal(plugins.installed().find((skill) => skill.id === entry.id)?.enabled, false);
  } finally {
    const resolved = await fs.realpath(stateDir);
    const temp = await fs.realpath(os.tmpdir());
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-skill-lifecycle-')) throw Error('Unsafe lifecycle test cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
