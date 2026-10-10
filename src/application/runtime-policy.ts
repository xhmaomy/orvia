import path from 'node:path';
import { conflictError } from '../domain/errors.js';

export interface RuntimePolicy {
  allowedTools?: string[];
  deniedTools: string[];
  allowedWorkingDirectories?: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))]
    : [];
}

function intersect(lists: string[][]): string[] | undefined {
  if (lists.length === 0) return undefined;
  return lists.slice(1).reduce(
    (current, list) => current.filter((item) => list.includes(item)),
    lists[0] ?? [],
  );
}

export function resolveRuntimePolicy(values: unknown[]): RuntimePolicy {
  const allowedToolLists: string[][] = [];
  const deniedTools = new Set<string>();
  const allowedDirectoryLists: string[][] = [];

  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rules = value as Record<string, unknown>;
    const tools = rules.tools && typeof rules.tools === 'object' && !Array.isArray(rules.tools)
      ? rules.tools as Record<string, unknown>
      : {};
    if (Array.isArray(tools.allow)) allowedToolLists.push(stringList(tools.allow));
    for (const tool of stringList(tools.deny)) deniedTools.add(tool);

    if (Array.isArray(rules.allowedWorkingDirectories)) {
      const directories = stringList(rules.allowedWorkingDirectories).map((item) => path.resolve(item));
      if (directories.length > 0) allowedDirectoryLists.push(directories);
    }
  }

  const allowedTools = intersect(allowedToolLists);
  const allowedWorkingDirectories = intersect(allowedDirectoryLists);
  return {
    allowedTools: allowedTools?.filter((tool) => !deniedTools.has(tool)),
    deniedTools: [...deniedTools],
    allowedWorkingDirectories,
  };
}

export function assertWorkingDirectoryAllowed(
  workingDirectory: string | undefined,
  policy: RuntimePolicy,
): string {
  const resolved = path.resolve(workingDirectory ?? process.cwd());
  if (policy.allowedWorkingDirectories === undefined) return resolved;
  const allowed = policy.allowedWorkingDirectories.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) throw conflictError(`Working directory is not allowed by Permission Policy: ${resolved}`);
  return resolved;
}
