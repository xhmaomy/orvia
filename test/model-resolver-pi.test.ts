import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskApiKey, parseModelId, publicProviderConfig, toPiProviderId, withProviderApiKey } from '../src/application/model-resolver.js';

test('toPiProviderId maps Orvia provider types to Pi ids', () => {
  assert.equal(toPiProviderId('miniMax'), 'minimax-cn');
  assert.equal(toPiProviderId('minimax'), 'minimax-cn');
  assert.equal(toPiProviderId('minimax-cn'), 'minimax-cn');
  assert.equal(toPiProviderId('openai'), 'openai');
  assert.equal(toPiProviderId('anthropic'), 'anthropic');
});

test('parseModelId accepts positive integer ids only', () => {
  assert.equal(parseModelId(12), 12);
  assert.equal(parseModelId('12'), 12);
  assert.equal(parseModelId(0), undefined);
  assert.equal(parseModelId(-1), undefined);
  assert.equal(parseModelId(''), undefined);
  assert.equal(parseModelId(undefined), undefined);
});

test('provider api key helpers mask and merge configJson', () => {
  assert.equal(maskApiKey('sk-abcdefghijkl'), 'sk-a…ijkl');
  const saved = withProviderApiKey({ region: 'cn' }, 'secret-key-123456');
  assert.deepEqual(saved, { region: 'cn', apiKey: 'secret-key-123456' });
  const publicView = publicProviderConfig(saved);
  assert.equal(publicView.apiKeySet, true);
  assert.equal(publicView.apiKeyMasked, 'secr…3456');
  assert.deepEqual(publicView.configJson, { region: 'cn' });
  assert.deepEqual(withProviderApiKey(saved, ''), { region: 'cn' });
});
