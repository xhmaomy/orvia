import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BASE_AGENT_TOOLS,
  WEB_ACCESS_SKILL_KEY,
  collectSkillKeys,
  materializeSkillDirs,
  normalizeSkillKey,
  runtimePolicyFromSkills,
} from '../src/application/skills.js';

test('skill key normalization matches capability style', () => {
  assert.equal(normalizeSkillKey('Web Access'), 'web_access');
  assert.equal(normalizeSkillKey('web-access'), 'web_access');
  assert.equal(normalizeSkillKey('1bad'), undefined);
  assert.deepEqual(collectSkillKeys(['web_access', 'web_access', 'My_Skill']), ['web_access', 'my_skill']);
});

test('runtime policy unions skill tools with base agent tools', () => {
  const policy = runtimePolicyFromSkills([
    {
      id: 1,
      tenantId: 1,
      key: WEB_ACCESS_SKILL_KEY,
      name: '网络访问',
      description: null,
      kind: 'builtin',
      toolsJson: { allow: ['bash'] },
      contentMd: '# x',
      configJson: null,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  assert.ok(policy.allowedTools?.includes('bash'));
  for (const tool of BASE_AGENT_TOOLS) assert.ok(policy.allowedTools?.includes(tool));
});

test('materializeSkillDirs writes Pi SKILL.md directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orvia-skills-'));
  try {
    const paths = await materializeSkillDirs([
      {
        id: 1,
        tenantId: 1,
        key: 'web_access',
        name: '网络访问',
        description: 'desc',
        kind: 'builtin',
        toolsJson: { allow: ['bash'] },
        contentMd: '---\nname: web-access\ndescription: test\n---\n\n# Web\n',
        configJson: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ], root);
    assert.equal(paths.length, 1);
    const content = await fs.readFile(path.join(paths[0]!, 'SKILL.md'), 'utf8');
    assert.match(content, /name: web-access/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
