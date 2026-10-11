import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceLimit, acceptanceRuleLines, parseAcceptanceVerdict, type AcceptanceParty } from '../src/application/acceptance.js';

const analysis: AcceptanceParty = { key: 'a', name: '需求分析', nodeType: 'task' };
const design: AcceptanceParty = { key: 'b', name: '系统框架设计', nodeType: 'task' };
const start: AcceptanceParty = { key: 'start', name: '开始', nodeType: 'start' };
const researcher1: AcceptanceParty = { key: 'r1', name: '产品调研员 1', nodeType: 'task' };
const researcher2: AcceptanceParty = { key: 'r2', name: '产品调研员 2', nodeType: 'task' };

test('acceptance rules split into separate failure conditions', () => {
  assert.deepEqual(acceptanceRuleLines('缺少背景\n功能点不清'), ['缺少背景', '功能点不清']);
  assert.deepEqual(acceptanceRuleLines([' 缺少背景 ', '', '功能点不清']), ['缺少背景', '功能点不清']);
  assert.deepEqual(acceptanceRuleLines('   '), []);
});

test('a missing acceptance rule limit defaults to three returns', () => {
  assert.equal(acceptanceLimit(undefined), 3);
  assert.equal(acceptanceLimit('2'), 2);
  assert.equal(acceptanceLimit(0), 3);
});

test('an explicit pass does not send work back', () => {
  assert.deepEqual(parseAcceptanceVerdict('合格', [analysis]), { kind: 'pass' });
  assert.deepEqual(parseAcceptanceVerdict('结论：合格', [analysis, design]), { kind: 'pass' });
});

test('single upstream: mentioning 不合格条件 in a pass verdict stays a pass', () => {
  const text = [
    '合格',
    '依据：对照不合格条件"缺少验收标准"，原文已包含验收标准章节',
  ].join('\n');
  assert.equal(parseAcceptanceVerdict(text, [analysis]).kind, 'pass');
});

test('mentioning 不合格条件 in a pass verdict stays a pass', () => {
  const text = [
    '合格',
    '依据：对照不合格条件"调研的内容不详细，有不合理点"，两份内容均合格：',
    '- 产品调研员 1：原文齐全',
    '- 产品调研员 2：原文齐全',
  ].join('\n');
  assert.equal(parseAcceptanceVerdict(text, [researcher1, researcher2]).kind, 'pass');
});

test('single upstream: unnamed reject returns only that one node', () => {
  const verdict = parseAcceptanceVerdict('不合格\n原因：缺少验收标准', [analysis]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.equal(verdict.items.length, 1);
  assert.equal(verdict.items[0]?.party.key, 'a');
  assert.equal(verdict.items[0]?.party.name, '需求分析');
  assert.match(verdict.items[0]?.reason ?? '', /验收标准/);
});

test('single upstream: named reject still returns that one node', () => {
  const verdict = parseAcceptanceVerdict('不合格\n退回：需求分析\n原因：范围写得太宽', [analysis]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.deepEqual(verdict.items.map((item) => item.party.key), ['a']);
});

test('single upstream: wrong return name falls back to the only party', () => {
  const verdict = parseAcceptanceVerdict('不合格\n退回：不存在的节点\n原因：内容不够', [analysis]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.equal(verdict.items.length, 1);
  assert.equal(verdict.items[0]?.party.key, 'a');
});

test('only the named upstream is sent back', () => {
  const verdict = parseAcceptanceVerdict('不合格\n退回：需求分析\n原因：范围写得太宽', [analysis, design]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.deepEqual(verdict.items.map((item) => item.party.name), ['需求分析']);
});

test('several upstreams without a name are all sent back', () => {
  const verdict = parseAcceptanceVerdict('不合格\n原因：两份报告都不详细', [analysis, design]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.deepEqual(verdict.items.map((item) => item.party.key).sort(), ['a', 'b']);
});

test('single start-node reject is parsed for human handling, not auto-confused with multi-node', () => {
  const verdict = parseAcceptanceVerdict('不合格\n原因：需求描述是空的', [start]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.equal(verdict.items.length, 1);
  assert.equal(verdict.items[0]?.party.nodeType, 'start');
});

test('start-node rejects are still parsed for human handling', () => {
  assert.equal(parseAcceptanceVerdict('不合格\n退回：开始\n原因：需求描述是空的', [start]).kind, 'reject');
});

test('unrelated text stays unresolved', () => {
  assert.equal(parseAcceptanceVerdict('看了一下', [analysis]).kind, 'unclear');
});
