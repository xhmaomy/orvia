import { db, pool } from './src/db/client.js';
import { workflows, workflowNodes } from './src/db/schema.js';
import { eq } from 'drizzle-orm';

async function testRealAPICall() {
  console.log('\n🔬 === 模拟真实 API 调用 ===\n');

  try {
    // 获取工作流和节点信息
    const workflow = (await db.select().from(workflows).limit(1))[0];
    if (!workflow) { console.log('❌ 没有工作流'); return; }

    const nodes = await db.select().from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflow.id));
    const taskNode = nodes.find(n => n.nodeType === 'task');
    if (!taskNode) { console.log('❌ 没有 task 节点'); return; }

    const config = typeof taskNode.configJson === 'string'
      ? JSON.parse(taskNode.configJson)
      : taskNode.configJson;

    console.log(`工作流: ${workflow.name} (ID: ${workflow.id})`);
    console.log(`节点: ${taskNode.name} (key: ${config.key})`);
    console.log(`\n📝 模拟请求:`);
    console.log(`   POST http://127.0.0.1:4100/api/workflows/${workflow.id}/messages`);
    console.log(`   Body: { "content": "@${taskNode.name} 你好", "mentions": ["${config.key}"] }`);
    console.log(`\n⏳ 请手动执行以下 curl 命令测试:\n`);

    const curlCmd = `curl -N -X POST http://127.0.0.1:4100/api/workflows/${workflow.id}/messages \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \$(cat /tmp/test_token 2>/dev/null || echo 'YOUR_TOKEN_HERE')" \\
  -d '{"content":"@${taskNode.name.replace(/ /g, '\\ ')} 你好","mentions":["${config.key}"]}'`;

    console.log(curlCmd);
    console.log(`\n💡 或者直接在浏览器中:`);
    console.log(`   1. 打开 F12 → Network 标签`);
    console.log(`   2. 在聊天框输入: @${taskNode.name} 你好`);
    console.log(`   3. 点击发送`);
    console.log(`   4. 观察 Network 中的请求和响应`);

  } catch (error) {
    console.error('❌ 错误:', error);
  } finally {
    await pool.end();
  }
}

testRealAPICall();
