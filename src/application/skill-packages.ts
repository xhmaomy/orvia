import { spawn } from 'node:child_process';
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrviaError } from '../domain/errors.js';

/** 所有自定义 Skill 统一落在此目录，便于查找和维护。 */
export const SKILL_STORE_ROOT = path.join(os.homedir(), '.orvia', 'skills');
const SKILL_META = '.orvia-skill.json';
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

export type SkillFrontmatter = {
  name?: string;
  description?: string;
};

type SkillMeta = { tenantId: number; key: string };

export function skillStoreRoot(): string {
  return SKILL_STORE_ROOT;
}

function preferredSkillDir(skillKey: string): string {
  return path.join(SKILL_STORE_ROOT, skillKey);
}

function tenantScopedSkillDir(tenantId: number, skillKey: string): string {
  return path.join(SKILL_STORE_ROOT, `${skillKey}__tenant-${tenantId}`);
}

function legacySkillDir(tenantId: number, skillKey: string): string {
  return path.join(SKILL_STORE_ROOT, String(tenantId), skillKey);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readSkillMeta(dir: string): Promise<SkillMeta | null> {
  try {
    const raw = await readFile(path.join(dir, SKILL_META), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillMeta>;
    if (typeof parsed.tenantId === 'number' && typeof parsed.key === 'string') {
      return { tenantId: parsed.tenantId, key: parsed.key };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function writeSkillMeta(dir: string, tenantId: number, skillKey: string): Promise<void> {
  await writeFile(path.join(dir, SKILL_META), `${JSON.stringify({ tenantId, key: skillKey }, null, 2)}\n`, 'utf8');
}

async function ensureStoreReadme(): Promise<void> {
  await mkdir(SKILL_STORE_ROOT, { recursive: true });
  const readme = path.join(SKILL_STORE_ROOT, 'README.md');
  if (await pathExists(readme)) return;
  await writeFile(readme, `# Orvia Skills

自定义 Skill 统一存放在本目录（\`~/.orvia/skills\`）。

- 每个 Skill 一个子目录，目录名通常就是 Skill 标识（如 \`my_research/\`）
- 目录内至少包含 \`SKILL.md\`，也可包含 \`scripts/\`、\`references/\`、\`assets/\` 等
- 元数据文件 \`.orvia-skill.json\` 由 Orvia 维护，请勿手工删除

执行 Workflow 时，Orvia 会把这里勾选的 Skill 复制到工作区的 \`.orvia/skills/\`，再交给 Pi 的 \`--skill\` 加载。
`, 'utf8');
}

/**
 * 解析 Skill 本地目录：优先 ~/.orvia/skills/{key}，兼容旧路径 ~/.orvia/skills/{tenantId}/{key}。
 * 同名跨租户冲突时使用 {key}__tenant-{id}。
 */
export async function skillStoreDir(tenantId: number, skillKey: string): Promise<string> {
  await ensureStoreReadme();
  const preferred = preferredSkillDir(skillKey);
  const scoped = tenantScopedSkillDir(tenantId, skillKey);
  const legacy = legacySkillDir(tenantId, skillKey);

  if (await pathExists(preferred)) {
    const meta = await readSkillMeta(preferred);
    if (!meta || meta.tenantId === tenantId) return preferred;
    return scoped;
  }
  if (await pathExists(scoped)) return scoped;
  if (await pathExists(path.join(legacy, 'SKILL.md'))) {
    // 旧版按租户分子目录：迁到统一目录，方便查找
    const target = (await pathExists(preferred)) && (await readSkillMeta(preferred))?.tenantId !== tenantId
      ? scoped
      : preferred;
    if (!(await pathExists(target))) {
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await rename(legacy, target);
      } catch {
        await cp(legacy, target, { recursive: true });
        await rm(legacy, { recursive: true, force: true });
      }
      await writeSkillMeta(target, tenantId, skillKey);
    }
    return target;
  }
  return preferred;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter & { body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: content };
  const raw = match[1] ?? '';
  const body = match[2] ?? '';
  const fields: SkillFrontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && value) fields.name = value;
    if (key === 'description' && value) fields.description = value;
  }
  return { ...fields, body };
}

async function listFilesRecursive(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === SKILL_META) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function findSkillMdRoot(extractRoot: string): Promise<string> {
  const direct = path.join(extractRoot, 'SKILL.md');
  if (await pathExists(direct)) return extractRoot;
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const dirs = entries.filter((item) => item.isDirectory() && !item.name.startsWith('.'));
  if (dirs.length === 1) {
    const nested = path.join(extractRoot, dirs[0]!.name);
    if (await pathExists(path.join(nested, 'SKILL.md'))) return nested;
  }
  for (const entry of dirs) {
    const nested = path.join(extractRoot, entry.name);
    if (await pathExists(path.join(nested, 'SKILL.md'))) return nested;
  }
  throw new OrviaError('Skill 包里必须包含 SKILL.md（可在根目录或一层子目录）', 'validation', 400);
}

async function prepareSkillDestination(tenantId: number, skillKey: string): Promise<string> {
  const dest = await skillStoreDir(tenantId, skillKey);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  return dest;
}

/** 把 zip Skill 包解压到统一 Skill 目录，返回 SKILL.md 文本与文件列表。 */
export async function installSkillZipPackage(input: {
  tenantId: number;
  skillKey: string;
  zip: Buffer;
}): Promise<{ contentMd: string; files: string[]; storePath: string }> {
  if (input.zip.byteLength === 0) throw new OrviaError('上传的 Skill 包是空的', 'validation', 400);
  if (input.zip.byteLength > MAX_PACKAGE_BYTES) throw new OrviaError('Skill 包不能超过 20MB', 'validation', 400);

  const tmpRoot = path.join(os.tmpdir(), `orvia-skill-${input.tenantId}-${Date.now()}`);
  const zipPath = path.join(tmpRoot, 'package.zip');
  const extractRoot = path.join(tmpRoot, 'extract');
  try {
    await mkdir(extractRoot, { recursive: true });
    await writeFile(zipPath, input.zip);
    await runCommand('unzip', ['-q', '-o', zipPath, '-d', extractRoot]);
    const packageRoot = await findSkillMdRoot(extractRoot);
    const contentMd = await readFile(path.join(packageRoot, 'SKILL.md'), 'utf8');
    if (!contentMd.trim()) throw new OrviaError('SKILL.md 不能为空', 'validation', 400);
    const dest = await prepareSkillDestination(input.tenantId, input.skillKey);
    await cp(packageRoot, dest, { recursive: true });
    await writeSkillMeta(dest, input.tenantId, input.skillKey);
    const files = await listFilesRecursive(dest);
    return { contentMd, files, storePath: dest };
  } catch (error) {
    if (error instanceof OrviaError) throw error;
    throw new OrviaError(error instanceof Error ? error.message : 'Skill 包解压失败', 'validation', 400);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 仅写入 SKILL.md，适合粘贴正文或上传单个 Markdown。 */
export async function installSkillMarkdown(input: {
  tenantId: number;
  skillKey: string;
  contentMd: string;
}): Promise<{ contentMd: string; files: string[]; storePath: string }> {
  const contentMd = input.contentMd.trim();
  if (!contentMd) throw new OrviaError('SKILL.md 内容不能为空', 'validation', 400);
  const dest = await prepareSkillDestination(input.tenantId, input.skillKey);
  await writeFile(path.join(dest, 'SKILL.md'), contentMd.endsWith('\n') ? contentMd : `${contentMd}\n`, 'utf8');
  await writeSkillMeta(dest, input.tenantId, input.skillKey);
  return { contentMd, files: ['SKILL.md'], storePath: dest };
}

export async function syncSkillMarkdownFile(tenantId: number, skillKey: string, contentMd: string): Promise<void> {
  const dest = await skillStoreDir(tenantId, skillKey);
  await mkdir(dest, { recursive: true });
  const text = contentMd.trim() ? (contentMd.endsWith('\n') ? contentMd : `${contentMd}\n`) : '';
  if (!text) return;
  await writeFile(path.join(dest, 'SKILL.md'), text, 'utf8');
  await writeSkillMeta(dest, tenantId, skillKey);
}

export async function removeSkillStore(tenantId: number, skillKey: string): Promise<void> {
  const candidates = [
    await skillStoreDir(tenantId, skillKey),
    preferredSkillDir(skillKey),
    tenantScopedSkillDir(tenantId, skillKey),
    legacySkillDir(tenantId, skillKey),
  ];
  for (const dir of [...new Set(candidates)]) {
    const meta = await readSkillMeta(dir);
    if (await pathExists(dir) && (!meta || meta.tenantId === tenantId)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function skillStoreFiles(tenantId: number, skillKey: string): Promise<string[]> {
  const dest = await skillStoreDir(tenantId, skillKey);
  if (!(await pathExists(dest))) return [];
  return listFilesRecursive(dest);
}

/** 执行前把统一 Skill 目录复制到工作区，供 Pi `--skill` 加载（含 scripts）。 */
export async function copySkillStoreToWorkspace(tenantId: number, skillKey: string, workspaceSkillDir: string): Promise<boolean> {
  const source = await skillStoreDir(tenantId, skillKey);
  const skillMd = path.join(source, 'SKILL.md');
  if (!(await pathExists(skillMd))) return false;
  await rm(workspaceSkillDir, { recursive: true, force: true });
  await mkdir(path.dirname(workspaceSkillDir), { recursive: true });
  await cp(source, workspaceSkillDir, { recursive: true });
  // 工作区不需要元数据文件
  await rm(path.join(workspaceSkillDir, SKILL_META), { force: true }).catch(() => undefined);
  return true;
}

export async function assertSkillStoreReady(tenantId: number, skillKey: string): Promise<void> {
  const skillMd = path.join(await skillStoreDir(tenantId, skillKey), 'SKILL.md');
  if (!(await pathExists(skillMd))) {
    throw new OrviaError(`Skill「${skillKey}」本地包不存在`, 'not_found', 404);
  }
  const info = await stat(skillMd);
  if (!info.isFile()) throw new OrviaError(`Skill「${skillKey}」本地包损坏`, 'validation', 400);
}
