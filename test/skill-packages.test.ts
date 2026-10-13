import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  installSkillMarkdown,
  installSkillZipPackage,
  parseSkillFrontmatter,
  removeSkillStore,
  skillStoreDir,
} from '../src/application/skill-packages.js';

test('parseSkillFrontmatter reads name and description', () => {
  const parsed = parseSkillFrontmatter(`---
name: demo-tools
description: Run demo scripts
---

# Demo
`);
  assert.equal(parsed.name, 'demo-tools');
  assert.equal(parsed.description, 'Run demo scripts');
  assert.match(parsed.body, /# Demo/);
});

test('installSkillZipPackage keeps scripts next to SKILL.md', async () => {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'orvia-skill-zip-'));
  const tenantId = 91001;
  const skillKey = 'demo_tools';
  try {
    const root = path.join(staging, 'demo-tools');
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(root, 'SKILL.md'), `---
name: demo-tools
description: Demo package
---

# Demo

Run \`scripts/hello.sh\`.
`);
    await fs.writeFile(path.join(root, 'scripts', 'hello.sh'), '#!/bin/sh\necho hello\n', { mode: 0o755 });
    const zipPath = path.join(staging, 'demo-tools.zip');
    const zipped = spawnSync('zip', ['-qr', zipPath, 'demo-tools'], { cwd: staging });
    assert.equal(zipped.status, 0, zipped.stderr?.toString());
    const zip = await fs.readFile(zipPath);
    const installed = await installSkillZipPackage({ tenantId, skillKey, zip });
    assert.ok(installed.files.includes('SKILL.md'));
    assert.ok(installed.files.includes('scripts/hello.sh'));
    const store = await skillStoreDir(tenantId, skillKey);
    assert.equal(store, path.join(os.homedir(), '.orvia', 'skills', skillKey));
    const script = await fs.readFile(path.join(store, 'scripts', 'hello.sh'), 'utf8');
    assert.match(script, /echo hello/);
  } finally {
    await removeSkillStore(tenantId, skillKey);
    await fs.rm(staging, { recursive: true, force: true });
  }
});

test('installSkillMarkdown writes under ~/.orvia/skills/{key}', async () => {
  const tenantId = 91002;
  const skillKey = 'plain_md';
  try {
    const installed = await installSkillMarkdown({
      tenantId,
      skillKey,
      contentMd: '---\nname: plain\ndescription: x\n---\n\n# Plain\n',
    });
    assert.deepEqual(installed.files, ['SKILL.md']);
    assert.equal(installed.storePath, path.join(os.homedir(), '.orvia', 'skills', skillKey));
  } finally {
    await removeSkillStore(tenantId, skillKey);
  }
});
