/**
 * Pick the task that represents each node key.
 * After「从头开始」, cancelled old tasks and new live tasks share keys — prefer non-cancelled.
 */
export function pickLatestTasksByKey(tasks) {
    const sorted = [...tasks].sort((left, right) => left.id - right.id);
    const map = new Map();
    for (const task of sorted) {
        if (!task.key)
            continue;
        const previous = map.get(task.key);
        if (!previous) {
            map.set(task.key, task);
            continue;
        }
        if (previous.status === 'cancelled' && task.status !== 'cancelled') {
            map.set(task.key, task);
            continue;
        }
        if (previous.status !== 'cancelled' && task.status === 'cancelled')
            continue;
        map.set(task.key, task);
    }
    return map;
}
/**
 * Decide whether「从当前节点继续」is allowed, and which nodes would run next.
 * Completed work is kept; awaiting_decision must be handled before resume.
 */
export function resumeFrontier(nodes, edges, tasksByKey) {
    if (nodes.length === 0)
        return { ok: false, reason: 'done' };
    for (const node of nodes) {
        if (!tasksByKey.has(node.key))
            return { ok: false, reason: 'changed' };
    }
    if ([...tasksByKey.values()].some((task) => task.status === 'awaiting_decision')) {
        return { ok: false, reason: 'awaiting' };
    }
    const frontier = nodes.filter((node) => {
        const task = tasksByKey.get(node.key);
        if (!task || task.status === 'completed')
            return false;
        const depends = edges.filter((edge) => edge.target === node.key).map((edge) => edge.source);
        return depends.every((source) => tasksByKey.get(source)?.status === 'completed');
    });
    if (frontier.length === 0)
        return { ok: false, reason: 'done' };
    return { ok: true, names: frontier.map((node) => node.name) };
}
