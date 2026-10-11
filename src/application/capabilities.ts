import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, capabilities, projects, workflowNodes, workflows } from '../db/schema.js';
import { OrviaError } from '../domain/errors.js';

export const defaultCapabilities = [
  { key: 'planning', name: '规划', description: '拆解目标并产出可执行计划' },
  { key: 'code_generation', name: '代码生成', description: '实现功能并提交可审查的改动' },
  { key: 'typescript', name: 'TypeScript', description: '使用 TypeScript 编写或修改代码' },
  { key: 'research', name: '调研', description: '收集资料并整理结论' },
  { key: 'human_review', name: '人工复核', description: '暂停执行，等待人来批准或要求修改' },
] as const;

export function normalizeCapabilityKey(value: string): string | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z0-9_]{0,119}$/.test(key) ? key : undefined;
}

export function collectCapabilityKeys(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new OrviaError('capabilitiesJson 必须是能力标识数组', 'validation', 400);
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const key = normalizeCapabilityKey(item);
    if (!key) throw new OrviaError(`能力标识「${item}」只能使用小写英文、数字和下划线，并以字母开头`, 'validation', 400);
    keys.push(key);
  }
  return [...new Set(keys)];
}

function keysFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === 'string' && normalizeCapabilityKey(item) ? [normalizeCapabilityKey(item)!] : []);
}

export function storedNodeCapabilityKeys(node: {
  capabilitiesJson?: unknown;
  capability?: string | null;
  skill?: string | null;
}): string[] {
  const listed = keysFromJson(node.capabilitiesJson);
  if (listed.length > 0) return [...new Set(listed)];
  const legacy = [node.capability, node.skill].flatMap((value) => {
    if (typeof value !== 'string') return [];
    const key = normalizeCapabilityKey(value);
    return key ? [key] : [];
  });
  return [...new Set(legacy)];
}

export function workflowNodeCapabilityKeys(item: Record<string, unknown>): string[] {
  if (item.capabilities !== undefined && item.capabilities !== null) return collectCapabilityKeys(item.capabilities);
  const legacy = [item.capability, item.skill].filter((value): value is string => typeof value === 'string');
  return collectCapabilityKeys(legacy);
}

export async function tenantIdOfProject(projectId: number): Promise<number> {
  const row = (await db.select({ tenantId: projects.tenantId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!row?.tenantId) throw new OrviaError('Project not found', 'not_found', 404);
  return row.tenantId;
}

/** 租户级能力目录：同一租户下所有项目共用。 */
export async function ensureTenantCapabilities(tenantId: number) {
  const existing = await db.select().from(capabilities).where(eq(capabilities.tenantId, tenantId));
  const known = new Set(existing.map((item) => item.key));
  const pending: { key: string; name: string; description: string }[] = defaultCapabilities
    .filter((item) => !known.has(item.key))
    .map((item) => ({ ...item }));

  const tenantProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.tenantId, tenantId));
  const projectIds = tenantProjects.map((item) => item.id);
  const projectAgents = projectIds.length
    ? await db.select({ capabilitiesJson: agents.capabilitiesJson }).from(agents).where(inArray(agents.projectId, projectIds))
    : [];
  const nodes = projectIds.length
    ? await db.select({
      capabilitiesJson: workflowNodes.capabilitiesJson,
      capability: workflowNodes.capability,
      skill: workflowNodes.skill,
    })
      .from(workflowNodes)
      .innerJoin(workflows, eq(workflows.id, workflowNodes.workflowId))
      .where(inArray(workflows.projectId, projectIds))
    : [];

  const stray = [
    ...projectAgents.flatMap((item) => keysFromJson(item.capabilitiesJson)),
    ...nodes.flatMap((item) => storedNodeCapabilityKeys(item)),
  ];
  for (const key of stray) {
    if (!known.has(key) && !pending.some((item) => item.key === key)) pending.push({ key, name: key, description: '' });
  }
  if (pending.length > 0) {
    await db.insert(capabilities).values(pending.map((item) => ({
      tenantId,
      key: item.key,
      name: item.name,
      description: item.description || null,
    })));
  }
  return db.select().from(capabilities).where(eq(capabilities.tenantId, tenantId)).orderBy(asc(capabilities.name));
}

export async function assertCatalogKeys(tenantId: number, values: Array<string | undefined>) {
  const rows = await ensureTenantCapabilities(tenantId);
  const known = new Set(rows.map((item) => item.key));
  const keys = collectCapabilityKeys(values.filter((item): item is string => Boolean(item)));
  const missing = keys.filter((key) => !known.has(key));
  if (missing.length > 0) throw new OrviaError(`未知能力标识：${missing.join(', ')}。请先加入能力目录`, 'validation', 400);
  return keys;
}

export async function assertProjectCatalogKeys(projectId: number, values: Array<string | undefined>) {
  return assertCatalogKeys(await tenantIdOfProject(projectId), values);
}
