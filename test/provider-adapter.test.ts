import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeProviderChat, httpProviderReady, providerAdapter } from '../src/infrastructure/provider-adapter.js';

test('provider adapter validates normalized provider configuration', () => {
  const adapter = providerAdapter('OpenAI');
  assert.equal(adapter.type, 'openai');
  assert.doesNotThrow(() => adapter.validate({ type: 'openai', model: 'gpt-5' }));
  assert.throws(() => adapter.validate({ type: 'anthropic', model: 'claude' }));
  assert.throws(() => adapter.validate({ type: 'openai', model: ' ' }));
});

test('http provider stays off without a key and completes with a mock response', async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(httpProviderReady('openai'), false);
  process.env.OPENAI_API_KEY = 'test-key';
  assert.equal(httpProviderReady('openai'), true);
  const calls: string[] = [];
  const text = await completeProviderChat({
    type: 'openai',
    model: 'gpt-test',
    prompt: 'hello',
    systemPrompt: 'be brief',
    apiKey: 'test-key',
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer test-key');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    },
  });
  assert.equal(text, 'ok');
  assert.equal(calls[0], 'https://api.openai.com/v1/chat/completions');
  if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAi;
  if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousAnthropic;
});

