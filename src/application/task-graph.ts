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

export function selectRunnableTasks<T extends GraphTask>(tasks: readonly T[]): T[] {
  const byNode = new Map(tasks.map((task) => [task.workflowNodeId, task]));
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
