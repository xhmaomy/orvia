import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const databaseUrl = process.env.ORVIA_INTEGRATION_DATABASE_URL;

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  do {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for condition; latest value: ${JSON.stringify(latest!)}`);
}

test('API Golden Path covers workflow execution and human decision', {
  skip: databaseUrl ? false : 'ORVIA_INTEGRATION_DATABASE_URL is not configured',
  timeout: 45_000,
}, async () => {
  const port = 4317;
  const baseUrl = `http://127.0.0.1:${port}`;
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'orvia-integration-'));
  const fakePi = path.join(fixtureDirectory, 'fake-pi.mjs');
  const argsFile = path.join(fixtureDirectory, 'pi-args.jsonl');
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(args) + '\\n');
const prompt = args.at(-1) ?? '';
if (prompt.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 600));
const text = prompt.includes('ORVIA_') ? prompt.match(/ORVIA_[A-Z_]+/)?.[0] ?? 'OK' : 'OK';
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
`, 'utf8');
  await chmod(fakePi, 0o755);

  let server: ChildProcess | undefined;
  const request = async <T>(pathname: string, body?: unknown, expected = body === undefined ? 200 : 201): Promise<T> => {
    const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json() as T;
    assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(data)}`);
    return data;
  };
  const list = async <T>(pathname: string) => (await request<{ data: T[] }>(pathname)).data;

  try {
    server = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL: databaseUrl!,
        PI_COMMAND: fakePi,
        FAKE_PI_ARGS_FILE: argsFile,
        WEB_ORIGIN: 'http://localhost:3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverError = '';
    server.stderr?.on('data', (chunk) => { serverError += String(chunk); });
    await waitFor(
      async () => fetch(`${baseUrl}/health`).then((response) => response.ok).catch(() => false),
      Boolean,
    ).catch((error) => { throw new Error(`${error.message}\n${serverError}`); });

    const project = await request<{ id: number }>('/api/projects', { name: `Integration ${Date.now()}` });
    const provider = await request<{ id: number }>('/api/model-providers', { name: `Fake ${Date.now()}`, type: 'fake' });
    const model = await request<{ id: number }>('/api/models', { providerId: provider.id, name: 'fake-model', displayName: 'Fake Model' });
    const agent = await request<{ id: number }>('/api/agents', { projectId: project.id, name: 'Integration Agent', capabilitiesJson: ['code_generation'] });
    await request('/api/agent-versions', { agentId: agent.id, modelId: model.id, version: 'v1', role: 'Builder' });

    const workflow = await request<{ id: number }>('/api/workflows', {
      projectId: project.id,
      name: 'Integration Workflow',
      version: 'v1',
      definitionJson: {
        nodes: [
          { key: 'build', name: 'Build', type: 'task', capability: 'code_generation', modelId: model.id, prompt: 'Reply ORVIA_WORKFLOW_OK' },
          { key: 'review', name: 'Review', type: 'checkpoint', question: 'Approve?' },
        ],
        edges: [{ source: 'build', target: 'review' }],
      },
    });
    const run = await request<{ id: number }>('/api/workflow-runs', { workflowId: workflow.id });
    await request(`/api/workflow-runs/${run.id}/execute`, {}, 202);
    const awaiting = await waitFor(
      () => request<{ data: { status: string; currentPlanVersion: number } }>(`/api/workflow-runs/${run.id}`),
      (value) => value.data.status === 'awaiting_decision',
    );
    assert.equal(awaiting.data.currentPlanVersion, 1);

    const firstDecision = (await list<{ id: number; status: string }>(`/api/decisions?projectId=${project.id}`))
      .find((item) => item.status === 'pending');
    assert.ok(firstDecision);
    await request(`/api/decisions/${firstDecision.id}/resolve`, { decision: 'Please replan', action: 'request_changes' }, 200);
    const replanned = await waitFor(
      () => request<{ data: { status: string; currentPlanVersion: number } }>(`/api/workflow-runs/${run.id}`),
      (value) => value.data.status === 'awaiting_decision' && value.data.currentPlanVersion === 2,
    );
    assert.equal(replanned.data.currentPlanVersion, 2);
    const secondDecision = (await list<{ id: number; status: string }>(`/api/decisions?projectId=${project.id}`))
      .find((item) => item.status === 'pending');
    assert.ok(secondDecision);
    await request(`/api/decisions/${secondDecision.id}/resolve`, { decision: 'Approved', action: 'approve' }, 200);
    await waitFor(
      () => request<{ data: { status: string } }>(`/api/workflow-runs/${run.id}`),
      (value) => value.data.status === 'completed',
    );

    const piArgs = (await readFile(argsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.ok(piArgs.some((args) => args.includes('--print')));
  } finally {
    server?.kill('SIGTERM');
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
