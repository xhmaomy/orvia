import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePiOutputLine, PiRuntimeAdapter, redactPiArgs } from '../src/runtime/pi-adapter.js';

test('Pi output parser exposes assistant text without protocol events', () => {
  assert.deepEqual(
    parsePiOutputLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'ORVIA_OK' },
    })),
    { handled: true, textDelta: 'ORVIA_OK' },
  );
  assert.deepEqual(
    parsePiOutputLine(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'ORVIA_OK' }] },
    })),
    { handled: true, finalText: 'ORVIA_OK', finalThinking: 'hidden' },
  );
  assert.deepEqual(
    parsePiOutputLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: '先看目录' },
    })),
    { handled: true, thinkingDelta: '先看目录' },
  );
  assert.deepEqual(parsePiOutputLine('plain output'), { handled: false });
  assert.deepEqual(
    parsePiOutputLine(JSON.stringify({ type: 'tool_execution_start', toolName: 'edit' })),
    { handled: true, activity: '正在按指导修改这个 Agent 的文件…' },
  );
});

test('PiRuntimeAdapter starts a process and waits for completion', async () => {
  const events: string[] = [];
  const output: string[] = [];
  const adapter = new PiRuntimeAdapter();
  const started = await adapter.start({
    sessionId: 7001,
    taskId: 1,
    command: '/bin/echo',
    prompt: 'orvia-test',
    provider: 'openai',
    model: 'gpt-4.1',
    apiKey: 'test-key',
    allowedTools: ['read', 'grep'],
    deniedTools: ['bash'],
    skillPaths: ['/tmp/orvia-skill'],
    disableDefaultSkills: true,
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === 'stdout' && typeof event.payload === 'string') output.push(event.payload);
    },
  });
  const completed = await adapter.wait(7001);

  assert.equal(started.status, 'running');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(events, ['started', 'stdout', 'completed']);
  assert.match(output.join(''), /--provider openai --model gpt-4\.1 --api-key test-key/);
  assert.match(output.join(''), /--tools read,grep --exclude-tools bash/);
  assert.match(output.join(''), /--no-skills/);
  assert.match(output.join(''), /--skill \/tmp\/orvia-skill/);
});

test('redactPiArgs hides api key values', () => {
  assert.deepEqual(
    redactPiArgs(['--provider', 'openai', '--api-key', 'sk-secret', '--model', 'gpt']),
    ['--provider', 'openai', '--api-key', '***', '--model', 'gpt'],
  );
});

test('PiRuntimeAdapter refuses partial credentials', async () => {
  const adapter = new PiRuntimeAdapter();
  await assert.rejects(
    () => adapter.start({
      sessionId: 7002,
      taskId: 1,
      command: '/bin/echo',
      prompt: 'x',
      provider: 'openai',
      model: 'gpt-4.1',
    }),
    /provider、model 和 apiKey/,
  );
});
