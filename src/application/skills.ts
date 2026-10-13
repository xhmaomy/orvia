import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, projects, skills } from '../db/schema.js';
import { OrviaError } from '../domain/errors.js';
import { resolveRuntimePolicy, type RuntimePolicy } from './runtime-policy.js';
import { tenantIdOfProject } from './capabilities.js';
import { copySkillStoreToWorkspace } from './skill-packages.js';

/** Pi 内置文件工具；联网能力通过 bash(curl) + SKILL.md 提供，便于后期换成 MCP/extension。 */
export const BASE_AGENT_TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const;

export const WEB_ACCESS_SKILL_KEY = 'web_access';

export const WEB_ACCESS_SKILL_MD = `---
name: web-access
description: Search the public web and fetch arbitrary URLs with curl. Use when the task needs current online information or remote page contents.
---

# Web access

You can reach the internet with the \`bash\` tool and \`curl\`. Use this skill whenever the task needs search results or the content of a URL.

## Search the web

Prefer DuckDuckGo HTML (no API key):

\`\`\`bash
curl -sL -A "Mozilla/5.0 (compatible; OrviaBot/1.0)" --max-time 30 \\
  "https://html.duckduckgo.com/html/?q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "YOUR QUERY")"
\`\`\`

Read titles and result links from the HTML. Follow up with Fetch when you need a specific page.

## Fetch a URL

\`\`\`bash
curl -sL -A "Mozilla/5.0 (compatible; OrviaBot/1.0)" --max-time 30 "https://example.com/path"
\`\`\`

## Rules

- Only request what the task needs; do not crawl broadly.
- Prefer text/HTML responses; truncate huge bodies before summarizing.
- Cite the final URLs you relied on in your answer.
- If a request fails, report the status/error and try an alternate source when useful.
`;

export const defaultSkills = [
  {
    key: WEB_ACCESS_SKILL_KEY,
    name: '网络访问',
    description: '允许搜索公开网页并抓取任意 URL（通过 bash + curl）',
    kind: 'builtin' as const,
    toolsJson: { allow: ['bash'] },
    contentMd: WEB_ACCESS_SKILL_MD,
  },
] as const;

export function normalizeSkillKey(value: string): string | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z0-9_]{0,119}$/.test(key) ? key : undefined;
}

export function collectSkillKeys(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new OrviaError('skillsJson 必须是 Skill 标识数组', 'validation', 400);
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const key = normalizeSkillKey(item);
    if (!key) throw new OrviaError(`Skill 标识「${item}」只能使用小写英文、数字和下划线，并以字母开头`, 'validation', 400);
    keys.push(key);
  }
  return [...new Set(keys)];
}

function keysFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const key = normalizeSkillKey(item);
    return key ? [key] : [];
  });
}

function skillDirectoryName(key: string): string {
  return key.replace(/_/g, '-');
}

export type SkillRow = typeof skills.$inferSelect;

/** 租户级 Skill 目录：内置 Skill 自动补齐，可后续增加自定义 Skill。 */
export async function ensureTenantSkills(tenantId: number) {
  const existing = await db.select().from(skills).where(eq(skills.tenantId, tenantId));
  const known = new Set(existing.map((item) => item.key));
  const pending = defaultSkills
    .filter((item) => !known.has(item.key))
    .map((item) => ({
      tenantId,
      key: item.key,
      name: item.name,
      description: item.description,
      kind: item.kind,
      toolsJson: item.toolsJson,
      contentMd: item.contentMd,
      status: 'active' as const,
    }));

  const tenantProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.tenantId, tenantId));
  const projectIds = tenantProjects.map((item) => item.id);
  const projectAgents = projectIds.length
    ? await db.select({ skillsJson: agents.skillsJson }).from(agents).where(inArray(agents.projectId, projectIds))
    : [];
  for (const key of projectAgents.flatMap((item) => keysFromJson(item.skillsJson))) {
    if (!known.has(key) && !pending.some((item) => item.key === key) && !defaultSkills.some((item) => item.key === key)) {
      // 残留引用不自动建自定义 Skill，留给校验报错
    }
  }

  if (pending.length > 0) await db.insert(skills).values(pending);

  // 内置 Skill 内容/工具以代码为准，启动时同步，避免旧 seed 过期
  for (const builtin of defaultSkills) {
    const row = (await db.select().from(skills).where(and(eq(skills.tenantId, tenantId), eq(skills.key, builtin.key))))[0];
    if (!row) continue;
    await db.update(skills).set({
      name: builtin.name,
      description: builtin.description,
      kind: 'builtin',
      toolsJson: builtin.toolsJson,
      contentMd: builtin.contentMd,
      status: 'active',
    }).where(eq(skills.id, row.id));
  }

  return db.select().from(skills).where(eq(skills.tenantId, tenantId)).orderBy(asc(skills.name));
}

export async function assertSkillCatalogKeys(tenantId: number, values: Array<string | undefined>) {
  const rows = await ensureTenantSkills(tenantId);
  const known = new Set(rows.filter((item) => item.status === 'active').map((item) => item.key));
  const keys = collectSkillKeys(values.filter((item): item is string => Boolean(item)));
  const missing = keys.filter((key) => !known.has(key));
  if (missing.length > 0) throw new OrviaError(`未知 Skill 标识：${missing.join(', ')}。请先加入 Skill 目录`, 'validation', 400);
  return keys;
}

export async function assertProjectSkillKeys(projectId: number, values: Array<string | undefined>) {
  return assertSkillCatalogKeys(await tenantIdOfProject(projectId), values);
}

export async function loadAgentSkills(agentSkillsJson: unknown, tenantId: number): Promise<SkillRow[]> {
  const keys = collectSkillKeys(agentSkillsJson);
  if (keys.length === 0) return [];
  await ensureTenantSkills(tenantId);
  const rows = await db.select().from(skills).where(and(eq(skills.tenantId, tenantId), inArray(skills.key, keys)));
  const byKey = new Map(rows.filter((item) => item.status === 'active').map((item) => [item.key, item]));
  return keys.map((key) => byKey.get(key)).filter((item): item is SkillRow => Boolean(item));
}

export function runtimePolicyFromSkills(skillRows: SkillRow[]): RuntimePolicy {
  if (skillRows.length === 0) return resolveRuntimePolicy([]);
  const allow = new Set<string>(BASE_AGENT_TOOLS);
  const deny = new Set<string>();
  for (const skill of skillRows) {
    const tools = skill.toolsJson && typeof skill.toolsJson === 'object' && !Array.isArray(skill.toolsJson)
      ? skill.toolsJson as Record<string, unknown>
      : {};
    for (const tool of Array.isArray(tools.allow) ? tools.allow : []) {
      if (typeof tool === 'string' && tool.trim()) allow.add(tool.trim());
    }
    for (const tool of Array.isArray(tools.deny) ? tools.deny : []) {
      if (typeof tool === 'string' && tool.trim()) deny.add(tool.trim());
    }
  }
  return {
    allowedTools: [...allow].filter((tool) => !deny.has(tool)),
    deniedTools: [...deny],
  };
}

/** 把选中的 Skill 写成 Pi 可加载目录（优先复制本地包，含 scripts），返回目录路径。 */
export async function materializeSkillDirs(skillRows: SkillRow[], workingDirectory: string): Promise<string[]> {
  if (skillRows.length === 0) return [];
  const root = path.join(workingDirectory, '.orvia', 'skills');
  await fs.mkdir(root, { recursive: true });
  const paths: string[] = [];
  for (const skill of skillRows) {
    const dir = path.join(root, skillDirectoryName(skill.key));
    const copied = await copySkillStoreToWorkspace(skill.tenantId, skill.key, dir);
    if (!copied) {
      const content = typeof skill.contentMd === 'string' && skill.contentMd.trim()
        ? skill.contentMd
        : `---\nname: ${skillDirectoryName(skill.key)}\ndescription: ${skill.description ?? skill.name}\n---\n\n# ${skill.name}\n`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
    }
    paths.push(dir);
  }
  return paths;
}
