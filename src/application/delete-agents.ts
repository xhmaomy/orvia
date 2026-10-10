import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentVersions,
  agents,
  events,
  sessions,
  tasks,
} from '../db/schema.js';

export async function deleteAgentsByIds(executor: typeof db, agentIds: number[]): Promise<void> {
  if (agentIds.length === 0) return;
  await executor.delete(agentVersions).where(inArray(agentVersions.agentId, agentIds));
  await executor.update(tasks).set({ agentId: null }).where(inArray(tasks.agentId, agentIds));
  await executor.update(sessions).set({ agentId: null }).where(inArray(sessions.agentId, agentIds));
  await executor.update(events).set({ agentId: null }).where(inArray(events.agentId, agentIds));
  await executor.delete(agents).where(inArray(agents.id, agentIds));
}
