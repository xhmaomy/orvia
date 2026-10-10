import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceLimit, acceptanceRuleLines, parseAcceptanceVerdict, type AcceptanceParty } from '../src/application/acceptance.js';

const analysis: AcceptanceParty = { key: 'a', name: '需求分析', nodeType: 'task' };
const design: AcceptanceParty = { key: 'b', name: '系统框架设计', nodeType: 'task' };
const start: AcceptanceParty = { key: 'start', name: '开始', nodeType: 'start' };

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

test('one upstream is sent back when the verdict does not name it', () => {
  const verdict = parseAcceptanceVerdict('不合格\n原因：缺少验收标准', [analysis]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.equal(verdict.items[0]?.party.key, 'a');
  assert.match(verdict.items[0]?.reason ?? '', /验收标准/);
});

test('only the named upstream is sent back', () => {
  const verdict = parseAcceptanceVerdict('不合格\n退回：需求分析\n原因：范围写得太宽', [analysis, design]);
  assert.equal(verdict.kind, 'reject');
  if (verdict.kind !== 'reject') return;
  assert.deepEqual(verdict.items.map((item) => item.party.name), ['需求分析']);
});

test('several upstreams without a name stay unresolved', () => {
  assert.equal(parseAcceptanceVerdict('不合格', [analysis, design]).kind, 'unclear');
  assert.equal(parseAcceptanceVerdict('看了一下', [analysis]).kind, 'unclear');
  assert.equal(parseAcceptanceVerdict('不合格\n退回：开始\n原因：需求描述是空的', [start]).kind, 'reject');
});
