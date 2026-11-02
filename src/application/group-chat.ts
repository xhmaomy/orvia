import { reachableFromRoots } from './task-graph.js';

export type MentionNode = { key: string; name: string };

export type GroupReply = { kind: 'direct' | 'checkpoint'; nodeKey: string };

export type GroupRoute =
  | { kind: 'save' }
  | { kind: 'conductor'; nodeKeys: string[] }
  | { kind: 'checkpoint'; nodeKey: string }
  | { kind: 'direct'; nodeKey: string }
  | { kind: 'busy'; nodeKey: string }
  | { kind: 'broadcast'; replies: GroupReply[]; busyKeys: string[] };

/** 只认 @all 和 @节点名，正文里的单词 all 不算点名。 */
export function mentionKeysFromText(content: string, nodes: readonly MentionNode[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/@([^\s@]+)/g)) {
    const token = match[1] ?? '';
    if (/^all$/i.test(token)) {
      if (!seen.has('__all__')) {
        keys.push('__all__');
        seen.add('__all__');
      }
      continue;
    }
    const node = nodes.find((item) => item.name === token || item.key === token);
    if (!node || seen.has(node.key)) continue;
    keys.push(node.key);
    seen.add(node.key);
  }
  return keys;
}

export function routeGroupMessage(input: {
  mentionKeys: readonly string[];
  chatableKeys: ReadonlySet<string>;
  checkpointKeys: ReadonlySet<string>;
  busyKeys: ReadonlySet<string>;
}): GroupRoute {
  const mentions = input.mentionKeys.filter((key) => key === '__all__' || input.chatableKeys.has(key) || input.checkpointKeys.has(key));
  if (mentions.length === 0) return { kind: 'save' };
  if (mentions.includes('__all__') || mentions.length > 1) {
    const nodeKeys = mentions.includes('__all__')
      ? [...input.chatableKeys, ...input.checkpointKeys]
      : mentions.filter((key) => key !== '__all__');
    const busyKeys = nodeKeys.filter((key) => input.busyKeys.has(key));
    const replies: GroupReply[] = nodeKeys
      .filter((key) => !input.busyKeys.has(key))
      .map((nodeKey) => ({ kind: input.checkpointKeys.has(nodeKey) ? 'checkpoint' : 'direct', nodeKey }));
    if (replies.length === 0) return { kind: 'conductor', nodeKeys: busyKeys };
    return { kind: 'broadcast', replies, busyKeys };
  }
  const nodeKey = mentions[0]!;
  if (input.checkpointKeys.has(nodeKey)) return { kind: 'checkpoint', nodeKey };
  if (input.busyKeys.has(nodeKey)) return { kind: 'busy', nodeKey };
  return { kind: 'direct', nodeKey };
}

export function splitNodeAction(text: string): { visible: string; action: 'execute' | 'reply' } {
  const match = text.match(/\{[^{}]*"action"\s*:\s*"(execute|reply)"[^{}]*\}\s*$/);
  if (!match || match.index === undefined) return { visible: text.trim(), action: 'reply' };
  const action = match[1] === 'execute' ? 'execute' : 'reply';
  return { visible: text.slice(0, match.index).trim(), action };
}

export function executionFocusKeys(
  nodeKeys: readonly string[],
  edges: readonly { source: string; target: string }[],
  seed: string,
): string[] {
  return [...reachableFromRoots(nodeKeys, edges, [seed])];
}

export function dependenciesSatisfied(
  nodeKey: string,
  edges: readonly { source: string; target: string }[],
  completedKeys: ReadonlySet<string>,
): boolean {
  return edges.filter((edge) => edge.target === nodeKey).every((edge) => completedKeys.has(edge.source));
}

export function handoffContent(summary: string, downstreamNames: readonly string[]): string {
  const body = summary.trim();
  if (downstreamNames.length === 0) return body;
  const mentions = downstreamNames.map((name) => `@${name}`).join(' ');
  return body ? `${body}\n${mentions}` : mentions;
}

/** 从群里开始时，只重置被点名的节点；它已经跑过时，下游也回到等待，好让同一条链再走一遍。 */
export function focusTaskUpdates(input: {
  seedKey: string;
  seedStatus: string;
  focusKeys: readonly string[];
  edges: readonly { source: string; target: string }[];
  statuses: ReadonlyMap<string, string>;
}): Map<string, 'pending' | 'blocked'> {
  const rerun = input.seedStatus === 'completed' || input.seedStatus === 'failed' || input.seedStatus === 'cancelled';
  const updates = new Map<string, 'pending' | 'blocked'>();
  for (const key of input.focusKeys) {
    const status = input.statuses.get(key);
    if (!status || status === 'running') continue;
    if (key !== input.seedKey && !rerun) continue;
    const deps = input.edges.filter((edge) => edge.target === key);
    updates.set(key, key === input.seedKey ? 'pending' : (deps.length > 0 ? 'blocked' : 'pending'));
  }
  return updates;
}

export function taskKeyInFocus(nodeKey: string, focusKeys: readonly string[] | null): boolean {
  if (!focusKeys || focusKeys.length === 0) return true;
  return focusKeys.includes(nodeKey);
}
