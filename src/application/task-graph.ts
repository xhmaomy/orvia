export interface GraphTask {
  id: number;
  workflowNodeId: number | null;
  status: string;
  inputJson: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 画布重存后列上的 workflow_node_id 常被清空，需回退到 inputJson 里快照的节点 id */
export function effectiveWorkflowNodeId(task: { workflowNodeId: number | null; inputJson: unknown }): number | null {
  if (task.workflowNodeId != null) return task.workflowNodeId;
  const raw = record(task.inputJson).workflowNodeId;
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function selectRunnableTasks<T extends GraphTask>(tasks: readonly T[]): T[] {
  const byNode = new Map<number, T>();
  for (const task of tasks) {
    const nodeId = effectiveWorkflowNodeId(task);
    if (nodeId != null) byNode.set(nodeId, task);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((candidate) => {
    if (candidate.status !== 'pending' && candidate.status !== 'blocked') return false;
    const input = record(candidate.inputJson);
    const nodeDependencies = Array.isArray(input.dependsOnNodeIds) ? input.dependsOnNodeIds.map(Number) : [];
    const taskDependencies = Array.isArray(input.dependsOnTaskIds) ? input.dependsOnTaskIds.map(Number) : [];
    return nodeDependencies.every((nodeId) => byNode.get(nodeId)?.status === 'completed')
      && taskDependencies.every((taskId) => byId.get(taskId)?.status === 'completed');
  });
}

export function selectRunnableTask<T extends GraphTask>(tasks: readonly T[]): T | undefined {
  return selectRunnableTasks(tasks)[0];
}

export function graphIsComplete(tasks: readonly GraphTask[]): boolean {
  return tasks.every((task) => task.status === 'completed' || task.status === 'cancelled');
}

export function assertAcyclicGraph(nodes: readonly string[], edges: readonly { source: string; target: string }[]): void {
  if (new Set(nodes).size !== nodes.length) throw new Error('Workflow node keys must be unique');
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) throw new Error('Workflow edge references an unknown node');
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodes.filter((node) => incoming.get(node) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(node) ?? []) {
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  if (visited !== nodes.length) throw new Error('Workflow graph must be acyclic');
}

/** 从开始节点（或给定根）沿出边可达的节点；未连通的孤立节点不应执行 */
export function reachableFromRoots<T extends string | number>(
  nodeIds: readonly T[],
  edges: readonly { source: T; target: T }[],
  roots: readonly T[],
): Set<T> {
  const known = new Set(nodeIds);
  const outgoing = new Map<T, T[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
  }
  const reachable = new Set<T>();
  const queue = roots.filter((id) => known.has(id));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }
  return reachable;
}

export function plannedTaskStatus(
  nodeId: number,
  dependsOnNodeIds: readonly number[],
  reachable: Set<number> | null,
): 'pending' | 'blocked' | 'cancelled' {
  if (reachable && !reachable.has(nodeId)) return 'cancelled';
  return dependsOnNodeIds.length > 0 ? 'blocked' : 'pending';
}
