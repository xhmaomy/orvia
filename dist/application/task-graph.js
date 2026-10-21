function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
/** 画布重存后列上的 workflow_node_id 常被清空，需回退到 inputJson 里快照的节点 id */
export function effectiveWorkflowNodeId(task) {
    if (task.workflowNodeId != null)
        return task.workflowNodeId;
    const raw = record(task.inputJson).workflowNodeId;
    const id = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
}
export function selectRunnableTasks(tasks) {
    const byNode = new Map();
    for (const task of tasks) {
        const nodeId = effectiveWorkflowNodeId(task);
        if (nodeId != null)
            byNode.set(nodeId, task);
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks.filter((candidate) => {
        if (candidate.status !== 'pending' && candidate.status !== 'blocked')
            return false;
        const input = record(candidate.inputJson);
        const nodeDependencies = Array.isArray(input.dependsOnNodeIds) ? input.dependsOnNodeIds.map(Number) : [];
        const taskDependencies = Array.isArray(input.dependsOnTaskIds) ? input.dependsOnTaskIds.map(Number) : [];
        return nodeDependencies.every((nodeId) => byNode.get(nodeId)?.status === 'completed')
            && taskDependencies.every((taskId) => byId.get(taskId)?.status === 'completed');
    });
}
export function selectRunnableTask(tasks) {
    return selectRunnableTasks(tasks)[0];
}
export function graphIsComplete(tasks) {
    return tasks.every((task) => task.status === 'completed' || task.status === 'cancelled');
}
export function assertAcyclicGraph(nodes, edges) {
    if (new Set(nodes).size !== nodes.length)
        throw new Error('Workflow node keys must be unique');
    const incoming = new Map(nodes.map((node) => [node, 0]));
    const outgoing = new Map(nodes.map((node) => [node, []]));
    for (const edge of edges) {
        if (!incoming.has(edge.source) || !incoming.has(edge.target))
            throw new Error('Workflow edge references an unknown node');
        incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
        outgoing.get(edge.source).push(edge.target);
    }
    const queue = nodes.filter((node) => incoming.get(node) === 0);
    let visited = 0;
    while (queue.length > 0) {
        const node = queue.shift();
        visited += 1;
        for (const target of outgoing.get(node) ?? []) {
            const remaining = (incoming.get(target) ?? 0) - 1;
            incoming.set(target, remaining);
            if (remaining === 0)
                queue.push(target);
        }
    }
    if (visited !== nodes.length)
        throw new Error('Workflow graph must be acyclic');
}
/** 从开始节点（或给定根）沿出边可达的节点；未连通的孤立节点不应执行 */
export function reachableFromRoots(nodeIds, edges, roots) {
    const known = new Set(nodeIds);
    const outgoing = new Map();
    for (const id of nodeIds)
        outgoing.set(id, []);
    for (const edge of edges) {
        if (!known.has(edge.source) || !known.has(edge.target))
            continue;
        outgoing.get(edge.source).push(edge.target);
    }
    const reachable = new Set();
    const queue = roots.filter((id) => known.has(id));
    for (let index = 0; index < queue.length; index += 1) {
        const id = queue[index];
        if (reachable.has(id))
            continue;
        reachable.add(id);
        for (const next of outgoing.get(id) ?? []) {
            if (!reachable.has(next))
                queue.push(next);
        }
    }
    return reachable;
}
export function plannedTaskStatus(nodeId, dependsOnNodeIds, reachable) {
    if (reachable && !reachable.has(nodeId))
        return 'cancelled';
    return dependsOnNodeIds.length > 0 ? 'blocked' : 'pending';
}
