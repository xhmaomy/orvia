import { db, pool } from './src/db/client.js';
import { workflows, workflowNodes } from './src/db/schema.js';
import { eq } from 'drizzle-orm';

async function check() {
  const workflow = (await db.select().from(workflows).limit(1))[0];
  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflow.id));
  const taskNode = nodes.find(n => n.nodeType === 'task');
  const config = typeof taskNode.configJson === 'string' ? JSON.parse(taskNode.configJson) : taskNode.configJson;

  const email = `check_${Date.now()}@test.com`;
  await fetch('http://127.0.0.1:4100/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test123456', name: 'Check' })
  });
  
  const loginRes = await fetch('http://127.0.0.1:4100/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test123456' })
  });
  const { token, tenantId } = await loginRes.json();

  console.log('🔍 快速检查 @单节点功能...\n');
  
  const response = await fetch(`http://127.0.0.1:4100/api/workflows/${workflow.id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-orvia-tenant-id': tenantId,
      'Origin': 'http://localhost:3000'
    },
    body: JSON.stringify({
      content: `@${taskNode.name} CSS测试`,
      mentions: [config.key]
    })
  });

  console.log(`状态码: ${response.status}`);
  console.log(`CORS头: ${response.headers.get('access-control-allow-origin')}`);

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;
    let lastEvent = '';

    const timeout = setTimeout(() => reader.cancel(), 25000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      let currentEvent = '', currentData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7);
        else if (line.startsWith('data: ')) currentData = line.slice(6);
        else if (line === '' && currentEvent && currentData) {
          eventCount++;
          lastEvent = currentEvent;
          if (currentEvent === 'stream_done') {
            try {
              const data = JSON.parse(currentData);
              console.log(`✅ 收到回复: "${data.content?.slice(0, 50)}..."`);
            } catch {}
          }
          currentEvent = ''; currentData = '';
        }
      }
      if (lastEvent === 'done') break;
    }
    
    clearTimeout(timeout);
    reader.releaseLock();

    console.log(`\n事件数: ${eventCount}, 最后事件: ${lastEvent}`);
    console.log(lastEvent === 'done' ? '\n✅ 后端完全正常！问题在前端/浏览器' : '\n❌ 后端有问题');
  }

  await pool.end();
}

check().catch(e => console.error('错误:', e));
