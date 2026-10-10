const runTransitions = {
    pending: ['running', 'paused', 'cancelled'],
    running: ['paused', 'awaiting_decision', 'completed', 'failed', 'cancelled'],
    paused: ['running', 'cancelled'],
    awaiting_decision: ['running', 'paused', 'failed', 'cancelled'],
    completed: [],
    failed: ['running', 'paused', 'cancelled'],
    cancelled: [],
};
const taskTransitions = {
    pending: ['blocked', 'running', 'cancelled'],
    blocked: ['pending', 'running', 'cancelled'],
    running: ['pending', 'paused', 'awaiting_decision', 'completed', 'failed', 'cancelled'],
    paused: ['pending', 'running', 'cancelled'],
    awaiting_decision: ['pending', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: ['pending', 'cancelled'],
    cancelled: [],
};
export function canTransitionRun(from, to) {
    return from === to || runTransitions[from].includes(to);
}
export function canTransitionTask(from, to) {
    return from === to || taskTransitions[from].includes(to);
}
export function assertRunTransition(from, to) {
    if (!canTransitionRun(from, to))
        throw new Error(`Invalid workflow run transition: ${from} -> ${to}`);
}
export function assertTaskTransition(from, to) {
    if (!canTransitionTask(from, to))
        throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
