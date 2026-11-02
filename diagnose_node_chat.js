import { db, pool } from './src/db/client.js';
import { workflows, workflowNodes, models } from './src/db/schema.js';
import { eq, sql } from 'drizzle-orm';

async function diagnose() {
  console.log('\n🔍 === 节点聊天功能诊断 ===\n');

  try {
    // 1. 检查所有工作流
    const allWorkflows = await db.select({
      id: workflows.id,
      name: workflows.name,
      projectId: workflows.projectId
    }).from(workflows).limit(5);

    console.log(`📊 找到 ${allWorkflows.length} 个工作流:\n`);

    for (const wf of allWorkflows) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`工作流: ${wf.name} (ID: ${wf.id})`);
      console.log(`${'='.repeat(60)}`);

      // 2. 检查该工作流的所有节点
      const nodes = await db.select().from(workflowNodes)
        .where(eq(workflowNodes.workflowId, wf.id));

      console.log(`\n📦 节点数量: ${nodes.length}\n`);

      for (const node of nodes) {
        const config = typeof node.configJson === 'string'
          ? JSON.parse(node.configJson)
          : node.configJson;

        const hasModelId = config && config.modelId;
        const modelName = hasModelId ? config.modelId : '❌ 未配置';

        console.log(`  🤖 节点: ${node.name}`);
        console.log(`     类型: ${node.nodeType}`);
        console.log(`     Key: ${JSON.stringify(config)}`);
        console.log(`     模型: ${modelName}`);

        if (!hasModelId) {
          console.log('     ⚠️  问题: 该节点没有配置模型ID!');
          console.log('     💡 解决: 在工作流编辑器中为该节点选择一个AI模型');
        }

        // 检查模型是否存在（如果配置了）
        if (hasModelId && config.modelId) {
          try {
            const model = await db.select().from(models)
              .where(eq(models.id, config.modelId))
              .limit(1);

            if (model.length === 0) {
              console.log('     ❌ 错误: 配置的模型ID不存在于数据库中!');
            } else {
              console.log(`     ✅ 模型有效: ${model[0].name || model[0].id}`);
            }
          } catch (e) {
            console.log('     ❌ 检查模型时出错:', e.message);
          }
        }

        console.log('');
      }
    }

  } catch (error) {
    console.error('❌ 诊断过程中出错:', error);
  } finally {
    await pool.end();
  }

  console.log('\n✨ 诊断完成\n');
}

diagnose();