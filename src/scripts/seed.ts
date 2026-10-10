import { asc, eq } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { ensureTables, repairSchema } from '../db/ensure-schema.js';
import { bootstrapTenancy } from '../application/tenancy.js';
import {
  agentVersions,
  agents,
  modelProviders,
  models,
  projects,
  workflowEdges,
  workflowNodes,
  workflows,
} from '../db/schema.js';

async function seed() {
  await ensureTables();
  await repairSchema();
  const { tenantId } = await bootstrapTenancy();
  let project = (await db.select().from(projects).where(eq(projects.name, 'Orvia Revision 3 Demo')).limit(1))[0];
  if (!project) {
    const result = await db.insert(projects).values({ tenantId, name: 'Orvia Revision 3 Demo', description: 'Full MVP Golden Path demo' });
    project = (await db.select().from(projects).where(eq(projects.id, result[0].insertId)))[0]!;
  }

  let provider = (await db.select().from(modelProviders).where(eq(modelProviders.name, 'Demo Provider')).limit(1))[0];
  if (!provider) {
    const result = await db.insert(modelProviders).values({ name: 'Demo Provider', type: 'openai' });
    provider = (await db.select().from(modelProviders).where(eq(modelProviders.id, result[0].insertId)))[0]!;
  }

  let model = (await db.select().from(models).where(eq(models.name, 'demo-model')).limit(1))[0];
  if (!model) {
    const result = await db.insert(models).values({ providerId: provider.id, name: 'demo-model', displayName: 'Demo Model' });
    model = (await db.select().from(models).where(eq(models.id, result[0].insertId)))[0]!;
  }

  let agent = (await db.select().from(agents).where(eq(agents.projectId, project.id)).orderBy(asc(agents.id)).limit(1))[0];
  if (!agent) {
    const result = await db.insert(agents).values({
      projectId: project.id,
      name: 'Demo Builder',
      description: 'Executes the Revision 3 Golden Path',
      capabilitiesJson: ['planning', 'code_generation', 'typescript'],
    });
    agent = (await db.select().from(agents).where(eq(agents.id, result[0].insertId)))[0]!;
  }

  const version = (await db.select().from(agentVersions).where(eq(agentVersions.agentId, agent.id)).limit(1))[0];
  if (!version) {
    await db.insert(agentVersions).values({ agentId: agent.id, modelId: model.id, version: 'v1', role: 'Builder', systemPrompt: 'Produce concise, reviewable work.' });
  }

  let workflow = (await db.select().from(workflows).where(eq(workflows.projectId, project.id)).orderBy(asc(workflows.id)).limit(1))[0];
  if (!workflow) {
    const result = await db.insert(workflows).values({
      projectId: project.id,
      name: 'Revision 3 Golden Path',
      version: 'v1',
      status: 'published',
      definitionJson: { description: 'Plan, execute, then wait for human approval.' },
    });
    workflow = (await db.select().from(workflows).where(eq(workflows.id, result[0].insertId)))[0]!;
    const planning = await db.insert(workflowNodes).values({ workflowId: workflow.id, name: 'Plan', capability: 'planning', capabilitiesJson: ['planning'], nodeType: 'task' });
    const implementation = await db.insert(workflowNodes).values({
      workflowId: workflow.id,
      name: 'Implement',
      capability: 'code_generation',
      capabilitiesJson: ['code_generation', 'typescript'],
      nodeType: 'task',
    });
    const review = await db.insert(workflowNodes).values({
      workflowId: workflow.id,
      name: 'Human approval',
      capability: 'human_review',
      capabilitiesJson: ['human_review'],
      nodeType: 'checkpoint',
      configJson: { question: 'Approve the generated artifact?' },
    });
    await db.insert(workflowEdges).values([
      { workflowId: workflow.id, sourceNodeId: planning[0].insertId, targetNodeId: implementation[0].insertId },
      { workflowId: workflow.id, sourceNodeId: implementation[0].insertId, targetNodeId: review[0].insertId },
    ]);
  }

  console.log(JSON.stringify({ projectId: project.id, agentId: agent.id, workflowId: workflow.id }, null, 2));
}

seed().finally(() => pool.end());
