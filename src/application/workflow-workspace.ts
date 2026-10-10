import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type WorkflowLoop = { key: string; nodeKeys: string[]; maxIterations: number };
export type TerminalNode = {
  key: string;
  name: string;
  type: 'task' | 'checkpoint' | 'start' | 'end';
  x: number;
  y: number;
};
export type TerminalEdge = { source: string; target: string };

const MANAGED_ROOT = path.join(os.homedir(), '.orvia', 'workflows');
const WORKFLOW_MARKER = '.orvia-workflow';

export function workflowFolderName(name: string, workflowId: number): string {
  return folderBaseName(name, `workflow-${workflowId}`);
}

export function folderBaseName(name: string, fallback: string): string {
  return safeSegment(name.trim() || fallback);
}

export function sequenceFolderName(base: string, index: number, total: number): string {
  return total > 1 ? `${base}-${index}` : base;
}

export type DirectoryMove = { workflowId: number; from: string; to: string };

export async function resolveWorkflowRoot(workflowId: number, name: string, base = MANAGED_ROOT): Promise<{ root: string; moves: DirectoryMove[] }> {
  await ensureDirectory(base);
  const preferred = workflowFolderName(name, workflowId);
  let current = await locateWorkflowRoot(workflowId, base);
  if (!current) {
    current = path.join(base, `.pending-${workflowId}`);
    await ensureDirectory(current);
  }
  await writeFile(path.join(current, WORKFLOW_MARKER), `${workflowId}\n`, 'utf8');
  const moves = await renumberSequence(base, preferred, workflowId);
  const root = await locateWorkflowRoot(workflowId, base);
  if (!root) throw new Error('无法创建 Workflow 目录');
  return { root, moves };
}

export async function allocateSequenceFolder(parent: string, baseName: string): Promise<{ name: string; moves: Array<{ from: string; to: string }> }> {
  await ensureDirectory(parent);
  const entries = await readdir(parent, { withFileTypes: true });
  const existing = entries
    .filter((entry) => entry.isDirectory() && matchesSequence(entry.name, baseName))
    .map((entry) => entry.name)
    .sort((left, right) => sequenceIndex(left, baseName) - sequenceIndex(right, baseName));
  if (existing.length === 0) return { name: baseName, moves: [] };
  const total = existing.length + 1;
  const moves: Array<{ from: string; to: string }> = [];
  const staged: Array<{ source: string; staging: string; target: string }> = [];
  existing.forEach((name, index) => {
    const targetName = `${baseName}-${index + 1}`;
    if (name === targetName) return;
    const source = path.join(parent, name);
    const target = path.join(parent, targetName);
    moves.push({ from: source, to: target });
    staged.push({ source, staging: path.join(parent, `.rename-exec-${index}`), target });
  });
  for (const item of staged) {
    await rm(item.staging, { recursive: true, force: true });
    await rename(item.source, item.staging);
  }
  for (const item of staged) await rename(item.staging, item.target);
  return { name: `${baseName}-${total}`, moves };
}

async function locateWorkflowRoot(workflowId: number, base: string): Promise<string | undefined> {
  const entries = await readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(base, entry.name);
    if (await readOwner(directory) === workflowId) return directory;
  }
  const legacy = path.join(base, String(workflowId));
  return await directoryExists(legacy) ? legacy : undefined;
}

function matchesSequence(folderName: string, base: string): boolean {
  if (folderName === base) return true;
  const prefix = `${base}-`;
  if (!folderName.startsWith(prefix)) return false;
  return /^[1-9]\d*$/.test(folderName.slice(prefix.length));
}

function sequenceIndex(name: string, baseName: string): number {
  if (name === baseName) return 0;
  return Number(name.slice(baseName.length + 1));
}

async function renumberSequence(base: string, preferred: string, workflowId: number): Promise<DirectoryMove[]> {
  const entries = await readdir(base, { withFileTypes: true });
  const byOwner = new Map<number, string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(base, entry.name);
    const owner = await readOwner(directory);
    if (!owner) continue;
    if (owner === workflowId || matchesSequence(entry.name, preferred)) byOwner.set(owner, directory);
  }
  const pending = path.join(base, `.pending-${workflowId}`);
  if (byOwner.has(workflowId)) {
    const current = byOwner.get(workflowId);
    if (current && path.resolve(current) !== path.resolve(pending)) await rm(pending, { recursive: true, force: true });
  } else if (await directoryExists(pending)) {
    byOwner.set(workflowId, pending);
  }
  const group = [...byOwner.entries()].map(([id, directory]) => ({ id, directory })).sort((left, right) => left.id - right.id);
  const plan = group.map((item, index) => ({
    ...item,
    target: path.join(base, sequenceFolderName(preferred, index + 1, group.length)),
  }));
  const moving = plan.filter((item) => path.resolve(item.directory) !== path.resolve(item.target));
  const temporary: Array<{ target: string; staging: string }> = [];
  for (const item of moving) {
    const staging = path.join(base, `.rename-${item.id}`);
    await rm(staging, { recursive: true, force: true });
    await rename(item.directory, staging);
    temporary.push({ target: item.target, staging });
  }
  for (const item of temporary) await rename(item.staging, item.target);
  return moving.map((item) => ({ workflowId: item.id, from: item.directory, to: item.target }));
}

async function readOwner(directory: string): Promise<number | undefined> {
  try {
    const owner = Number((await readFile(path.join(directory, WORKFLOW_MARKER), 'utf8')).trim());
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

export async function openDirectory(target: string): Promise<void> {
  let directory = target;
  let revealFile = false;
  try {
    const info = await stat(target);
    if (info.isFile()) {
      directory = path.dirname(target);
      revealFile = true;
    }
  } catch {
    await ensureDirectory(directory);
  }
  if (!revealFile) await ensureDirectory(directory);
  const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = revealFile && process.platform === 'darwin' ? ['-R', target]
    : revealFile && process.platform === 'win32' ? ['/select,', target]
      : [directory];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', () => reject(new Error('无法打开目录')));
    child.once('close', (code) => {
      if (code === 0 || process.platform === 'win32') resolve();
      else reject(new Error('无法打开目录'));
    });
  });
}

export function inputDirectory(root: string): string {
  return path.join(root, 'input');
}

export function executionDirectory(root: string, executionId: string): string {
  return path.join(root, 'executions', executionId);
}

export function beijingParts(date: Date): { year: string; month: string; day: string; hour: string; minute: string; second: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour, minute: pick('minute'), second: pick('second') };
}

export function executionStamp(date = new Date()): string {
  const parts = beijingParts(date);
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

export function nodeDirectory(executionDir: string, nodeName: string, iteration?: number): string {
  const folder = path.join(executionDir, safeSegment(nodeName));
  return iteration && iteration > 1 ? path.join(folder, `第${iteration}次`) : folder;
}

export function isManagedWorkspace(directory: string): boolean {
  const relative = path.relative(MANAGED_ROOT, path.resolve(directory));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '');
  return base.slice(0, 120) || 'file';
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 80) || 'node';
}

export function withTerminals<T extends TerminalNode>(nodes: readonly T[], edges: readonly TerminalEdge[]): { nodes: T[]; edges: TerminalEdge[] } {
  const nextNodes = [...nodes];
  const nextEdges = edges.map((edge) => ({ source: edge.source, target: edge.target }));
  const hasStart = nextNodes.some((node) => node.type === 'start' || node.key === 'start');
  const hasEnd = nextNodes.some((node) => node.type === 'end' || node.key === 'end');
  const minX = nextNodes.reduce((min, node) => Math.min(min, node.x), 80);
  const maxX = nextNodes.reduce((max, node) => Math.max(max, node.x), 80);
  if (!hasStart) {
    nextNodes.unshift({ key: 'start', name: '开始', type: 'start', x: Math.max(8, minX - 280), y: 80 } as T);
  }
  if (!hasEnd) {
    nextNodes.push({ key: 'end', name: '结束', type: 'end', x: maxX + 280, y: 160 } as T);
  }
  const start = nextNodes.find((node) => node.type === 'start' || node.key === 'start');
  const end = nextNodes.find((node) => node.type === 'end' || node.key === 'end');
  if (!start || !end) return { nodes: nextNodes, edges: nextEdges };
  const middle = nextNodes.filter((node) => node.key !== start.key && node.key !== end.key);
  const incoming = new Set(nextEdges.map((edge) => edge.target));
  const outgoing = new Set(nextEdges.map((edge) => edge.source));
  for (const node of middle) {
    if (!incoming.has(node.key)) nextEdges.push({ source: start.key, target: node.key });
    if (!outgoing.has(node.key)) nextEdges.push({ source: node.key, target: end.key });
  }
  if (middle.length === 0 && !nextEdges.some((edge) => edge.source === start.key && edge.target === end.key)) {
    nextEdges.push({ source: start.key, target: end.key });
  }
  return { nodes: nextNodes, edges: nextEdges };
}

export function loopsFromDefinition(definition: unknown): WorkflowLoop[] {
  const record = definition && typeof definition === 'object' && !Array.isArray(definition) ? definition as Record<string, unknown> : {};
  const raw = Array.isArray(record.loops) ? record.loops : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const loop = item as Record<string, unknown>;
    const nodeKeys = Array.isArray(loop.nodeKeys) ? [...new Set(loop.nodeKeys.map(String).filter(Boolean))] : [];
    const maxIterations = Number(loop.maxIterations);
    const key = typeof loop.key === 'string' && loop.key.trim() ? loop.key.trim() : '';
    if (!key || nodeKeys.length === 0 || !Number.isInteger(maxIterations) || maxIterations < 1) return [];
    return [{ key, nodeKeys, maxIterations }];
  });
}

export function validateLoops(loops: readonly WorkflowLoop[], nodes: readonly { key: string; type: string }[]): string | undefined {
  const seen = new Set<string>();
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  for (const loop of loops) {
    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) return '循环次数至少为 1';
    const members = loop.nodeKeys.map((key) => byKey.get(key)).filter((node): node is { key: string; type: string } => Boolean(node));
    if (members.length !== loop.nodeKeys.length) return '循环里有不存在的节点';
    if (members.some((node) => node.type === 'start' || node.type === 'end')) return '开始和结束节点不能放进循环';
    if (!members.some((node) => node.type === 'task')) return '循环里至少要有一个任务节点';
    if (!members.some((node) => node.type === 'checkpoint')) return '循环里需要一个人工复核节点，用来选择通过或再做一次';
    for (const key of loop.nodeKeys) {
      if (seen.has(key)) return '同一个节点不能同时属于两个循环';
      seen.add(key);
    }
  }
  return undefined;
}

export function loopForNode(loops: readonly WorkflowLoop[], nodeKey: string): WorkflowLoop | undefined {
  return loops.find((loop) => loop.nodeKeys.includes(nodeKey));
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

export async function listInputFiles(root: string): Promise<Array<{ name: string; size: number }>> {
  const directory = inputDirectory(root);
  await ensureDirectory(directory);
  const names = await readdir(directory);
  const files = [];
  for (const name of names) {
    if (!safeFileName(name) || name.startsWith('.')) continue;
    const info = await stat(path.join(directory, name));
    if (!info.isFile()) continue;
    files.push({ name, size: info.size });
  }
  return files;
}

export async function saveInputFile(root: string, fileName: string, body: Buffer): Promise<string> {
  const name = safeFileName(fileName);
  const directory = inputDirectory(root);
  await ensureDirectory(directory);
  await writeFile(path.join(directory, name), body);
  return name;
}

export async function deleteInputFile(root: string, fileName: string): Promise<void> {
  const name = safeFileName(fileName);
  await rm(path.join(inputDirectory(root), name), { force: true });
}

export async function writeStartInput(directory: string, requirement: string, root: string): Promise<string[]> {
  await ensureDirectory(directory);
  await writeFile(path.join(directory, '需求.md'), requirement.trim() ? `${requirement.trim()}\n` : '（没有填写需求描述）\n', 'utf8');
  const files = await listInputFiles(root);
  const copied: string[] = [];
  for (const file of files) {
    await copyFile(path.join(inputDirectory(root), file.name), path.join(directory, file.name));
    copied.push(file.name);
  }
  return copied;
}

export async function writeTaskBrief(directory: string, title: string, instruction: string, upstream: string, outputRequirement = '', guidance = '', redoReason = ''): Promise<void> {
  await ensureDirectory(directory);
  const parts = [`# ${title}`];
  if (instruction.trim()) parts.push('', '## 任务说明', instruction.trim());
  if (outputRequirement.trim()) parts.push('', '## 产出要求', outputRequirement.trim());
  if (redoReason.trim()) parts.push('', '## 退回原因', redoReason.trim());
  if (guidance.trim()) parts.push('', '## 人工指导', guidance.trim());
  if (upstream.trim()) parts.push('', '## 上游产物', upstream.trim());
  await writeFile(path.join(directory, '任务.md'), `${parts.join('\n')}\n`, 'utf8');
}

export async function writeResult(directory: string, text: string): Promise<void> {
  await ensureDirectory(directory);
  await writeFile(path.join(directory, '结果.md'), text.trim() ? `${text.trim()}\n` : '（没有文字结果）\n', 'utf8');
}

export async function listDeliverableNames(directory: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (name === '任务.md' || name.startsWith('.')) continue;
    try {
      if ((await stat(path.join(directory, name))).isFile()) files.push(name);
    } catch {
      /* 跳过读不到的条目 */
    }
  }
  return files;
}

export async function readDeliverableText(directory: string, limit = 60_000): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return '';
  }
  const parts: string[] = [];
  let used = 0;
  for (const name of names.filter((item) => item !== '任务.md' && /\.(md|txt|json|csv)$/i.test(item)).sort()) {
    if (used >= limit) break;
    const full = path.join(directory, name);
    try {
      if (!(await stat(full)).isFile()) continue;
      const text = await readFile(full, 'utf8');
      const slice = text.slice(0, limit - used);
      parts.push(`#### ${name}\n${slice}`);
      used += slice.length;
    } catch {
      continue;
    }
  }
  return parts.join('\n\n');
}

export async function readResult(directory: string): Promise<string> {
  try {
    return (await readFile(path.join(directory, '结果.md'), 'utf8')).trim();
  } catch {
    return '';
  }
}
