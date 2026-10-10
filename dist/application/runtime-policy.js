import path from 'node:path';
import { conflictError } from '../domain/errors.js';
function stringList(value) {
    return Array.isArray(value)
        ? [...new Set(value
                .filter((item) => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean))]
        : [];
}
function intersect(lists) {
    if (lists.length === 0)
        return undefined;
    return lists.slice(1).reduce((current, list) => current.filter((item) => list.includes(item)), lists[0] ?? []);
}
export function resolveRuntimePolicy(values) {
    const allowedToolLists = [];
    const deniedTools = new Set();
    const allowedDirectoryLists = [];
    for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const rules = value;
        const tools = rules.tools && typeof rules.tools === 'object' && !Array.isArray(rules.tools)
            ? rules.tools
            : {};
        if (Array.isArray(tools.allow))
            allowedToolLists.push(stringList(tools.allow));
        for (const tool of stringList(tools.deny))
            deniedTools.add(tool);
        if (Array.isArray(rules.allowedWorkingDirectories)) {
            const directories = stringList(rules.allowedWorkingDirectories).map((item) => path.resolve(item));
            if (directories.length > 0)
                allowedDirectoryLists.push(directories);
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
export function assertWorkingDirectoryAllowed(workingDirectory, policy) {
    const resolved = path.resolve(workingDirectory ?? process.cwd());
    if (policy.allowedWorkingDirectories === undefined)
        return resolved;
    const allowed = policy.allowedWorkingDirectories.some((root) => {
        const relative = path.relative(root, resolved);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!allowed)
        throw conflictError(`Working directory is not allowed by Permission Policy: ${resolved}`);
    return resolved;
}
