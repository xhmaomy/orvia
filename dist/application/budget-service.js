import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { budgets, usageRecords } from '../db/schema.js';
import { conflictError } from '../domain/errors.js';
export async function reserveBudgetUnits(input) {
    return db.transaction(async (tx) => {
        const applicable = await tx.select().from(budgets)
            .where(and(eq(budgets.projectId, input.projectId), ne(budgets.status, 'closed'), input.workflowRunId
            ? or(isNull(budgets.workflowRunId), eq(budgets.workflowRunId, input.workflowRunId))
            : isNull(budgets.workflowRunId)))
            .orderBy(asc(budgets.id));
        const reserved = [];
        for (const budget of applicable) {
            const result = await tx.update(budgets).set({
                usedUnits: sql `${budgets.usedUnits} + 1`,
                status: sql `CASE WHEN ${budgets.usedUnits} + 1 >= ${budgets.limitUnits} THEN 'exhausted' ELSE 'active' END`,
            }).where(and(eq(budgets.id, budget.id), eq(budgets.status, 'active'), lt(budgets.usedUnits, budgets.limitUnits)));
            if (result[0].affectedRows !== 1) {
                throw conflictError(`Budget ${budget.id} is exhausted`);
            }
            await tx.insert(usageRecords).values({
                budgetId: budget.id,
                workflowRunId: input.workflowRunId,
                taskId: input.taskId,
                agentId: input.agentId,
                units: 1,
                metadataJson: { ...input.metadataJson, phase: 'reserved' },
            });
            reserved.push(budget.id);
        }
        return reserved;
    });
}
