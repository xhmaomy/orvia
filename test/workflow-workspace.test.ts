import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allocateSequenceFolder, directoryExists, executionStamp, loopForNode, nodeDirectory, resolveWorkflowRoot, sequenceFolderName, validateLoops, withTerminals, writeTaskBrief } from '../src/application/workflow-workspace.js';

test('workflow gains a start and an end around the existing chain', () => {
  const graph = withTerminals(
    [
      { key: 'need', name: '需求分析', type: 'task' as const, x: 80, y: 80 },
      { key: 'design', name: '系统框架设计', type: 'task' as const, x: 400, y: 80 },
    ],
    [{ source: 'need', target: 'design' }],
  );
  assert.equal(graph.nodes[0]?.key, 'start');
  assert.equal(graph.nodes.at(-1)?.key, 'end');
  assert.deepEqual(graph.edges, [
    { source: 'need', target: 'design' },
    { source: 'start', target: 'need' },
    { source: 'design', target: 'end' },
  ]);
});

test('loop needs a task, a checkpoint, and no shared nodes', () => {
  const nodes = [
    { key: 'start', type: 'start' },
    { key: 'build', type: 'task' },
    { key: 'review', type: 'checkpoint' },
    { key: 'polish', type: 'task' },
    { key: 'end', type: 'end' },
  ];
  assert.equal(validateLoops([{ key: 'loop-1', nodeKeys: ['build', 'review'], maxIterations: 3 }], nodes), undefined);
  assert.match(validateLoops([{ key: 'loop-1', nodeKeys: ['build'], maxIterations: 3 }], nodes) ?? '', /人工复核/);
  assert.match(validateLoops([
    { key: 'a', nodeKeys: ['build', 'review'], maxIterations: 2 },
    { key: 'b', nodeKeys: ['review', 'polish'], maxIterations: 2 },
  ], nodes) ?? '', /两个循环/);
  assert.equal(loopForNode([{ key: 'loop-1', nodeKeys: ['build', 'review'], maxIterations: 3 }], 'review')?.key, 'loop-1');
});

test('workflow directory uses the workflow name', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'orvia-workflows-'));
  try {
    await mkdir(path.join(base, '7'));
    const renamed = await resolveWorkflowRoot(7, '产品研发小组', '', base);
    assert.equal(renamed.root, path.join(base, '产品研发小组'));
    const same = await resolveWorkflowRoot(7, '产品研发小组', '', base);
    assert.equal(same.root, renamed.root);
    const other = await resolveWorkflowRoot(8, '产品研发小组', '', base);
    assert.equal(other.root, path.join(base, '产品研发小组-2'));
    const first = await resolveWorkflowRoot(7, '产品研发小组', '', base);
    assert.equal(first.root, path.join(base, '产品研发小组-1'));
    const unique = await resolveWorkflowRoot(9, '发布检查', '', base);
    assert.equal(unique.root, path.join(base, '发布检查'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('new workflow directory is grouped under the project folder', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'orvia-workflows-'));
  try {
    const created = await resolveWorkflowRoot(1, '产品研发小组', '智能终端', base);
    assert.equal(created.root, path.join(base, '智能终端', '产品研发小组'));
    // 同项目下同名再开一个，序号在项目目录内编号
    const second = await resolveWorkflowRoot(2, '产品研发小组', '智能终端', base);
    assert.equal(second.root, path.join(base, '智能终端', '产品研发小组-2'));
    // 另一个项目下同名，互不干扰
    const other = await resolveWorkflowRoot(3, '产品研发小组', '云平台', base);
    assert.equal(other.root, path.join(base, '云平台', '产品研发小组'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('existing workflow directory stays where it is after project grouping lands', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'orvia-workflows-'));
  try {
    // 老结构：目录直接在 base 下面
    const legacy = path.join(base, '产品研发小组');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, '.orvia-workflow'), '5\n', 'utf8');
    const kept = await resolveWorkflowRoot(5, '产品研发小组', '智能终端', base);
    assert.equal(kept.root, legacy);
    // 目录没有被搬进项目分组
    assert.equal(await directoryExists(path.join(base, '智能终端')), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('node directory uses the node name', () => {
  assert.equal(nodeDirectory('/tmp/run', '需求分析').endsWith('/需求分析'), true);
  assert.equal(nodeDirectory('/tmp/run', sequenceFolderName('需求分析', 2, 2)).endsWith('/需求分析-2'), true);
  assert.equal(sequenceFolderName('需求分析', 1, 1), '需求分析');
  assert.equal(nodeDirectory('/tmp/run', '系统框架设计', 2).endsWith('/系统框架设计/第2次'), true);
});

test('execution directory stamp uses Beijing time', () => {
  assert.equal(executionStamp(new Date('2026-10-06T15:38:04.000Z')), '2026-10-06_23-38-04');
});

test('a repeated directory name numbers every copy', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'orvia-sequence-'));
  try {
    await mkdir(path.join(parent, '2026-10-06_17-41-00'));
    const allocated = await allocateSequenceFolder(parent, '2026-10-06_17-41-00');
    assert.equal(allocated.name, '2026-10-06_17-41-00-2');
    assert.equal(allocated.moves[0]?.to, path.join(parent, '2026-10-06_17-41-00-1'));
    await access(allocated.moves[0]?.to ?? '');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('task brief keeps the required deliverable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orvia-brief-'));
  try {
    await writeTaskBrief(directory, '需求分析', '整理范围', '上游需求', '写成《需求分析文档》，包含背景、用户、功能范围、验收标准');
    const text = await readFile(path.join(directory, '任务.md'), 'utf8');
    assert.match(text, /## 产出要求\n写成《需求分析文档》/);
    assert.match(text, /## 任务说明\n整理范围/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
