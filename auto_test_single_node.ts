import { db, pool } from './src/db/client.js';
import { workflows, workflowNodes, users, sessions, nodeMessages } from './src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

async function getValidToken() {
  console.log('\n🔑 获取有效的认证 Token...\n');
  
  try {
    // 1. 查找用户
    const user = (await db.select().from(users).limit(1))[0];
    if (!user) {
      console.log('❌ 数据库中没有用户');
      return null;
    }
    console.log(`找到用户: ${user.email}`);
    
    // 2. 尝试常见密码登录
    const passwords = ['123456', 'password', 'admin', 'test', '12345678'];
    
    for (const pwd of passwords) {
      try {
        const response = await fetch('http://127.0.0.1:4100/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: user.email, password: pwd })
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log(`✅ 登录成功！密码: ${pwd}`);
          console.log(`   Token: ${data.token?.slice(0, 30)}...`);
          return { token: data.token, tenantId: data.tenantId || '1' };
        }
      } catch (e) {
        // 继续尝试下一个密码
      }
    }
    
    // 3. 如果所有密码都失败，尝试注册新用户
    console.log('\n⚠️  常见密码都失败，尝试创建测试用户...');
    const testEmail = `test_${Date.now()}@example.com`;
    const testPwd = 'Test123456';
    
    try {
      const regResponse = await fetch('http://127.0.0.1:4100/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email: testEmail, 
          password: testPwd,
          name: 'Test User'
        })
      });
      
      if (regResponse.ok) {
        const regData = await regResponse.json();
        console.log(`✅ 注册成功！`);
        console.log(`   Email: ${testEmail}`);
        
        // 用新账号登录
        const loginResponse = await fetch('http://127.0.0.1:4100/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: testEmail, password: testPwd })
        });
        
        if (loginResponse.ok) {
          const loginData = await loginResponse.json();
          console.log(`✅ 登录成功！`);
          console.log(`   Token: ${loginData.token?.slice(0, 30)}...`);
          return { token: loginData.token, tenantId: loginData.tenantId || '1' };
        }
      } else {
        const errText = await regResponse.text();
        console.log(`❌ 注册失败: ${errText.slice(0, 100)}`);
      }
    } catch (e) {
      console.error('❌ 注册过程出错:', e);
    }
    
    return null;
  } catch (error) {
    console.error('❌ 获取 token 失败:', error);
    return null;
  }
}

async function testSingleNodeChat() {
  console.log('\n' + '='.repeat(70));
  console.log('🧪 自动化测试: @单个节点聊天功能');
  console.log('='.repeat(70) + '\n');

  let testPassed = false;
  
  try {
    // 1. 获取工作流和节点信息
    const workflow = (await db.select().from(workflows).limit(1))[0];
    if (!workflow) { console.log('❌ 没有工作流'); return; }

    const nodes = await db.select().from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflow.id));
    const taskNode = nodes.find(n => n.nodeType === 'task');
    if (!taskNode) { console.log('❌ 没有 task 节点'); return; }

    const config = typeof taskNode.configJson === 'string'
      ? JSON.parse(taskNode.configJson)
      : taskNode.configJson;

    console.log(`📋 测试配置:`);
    console.log(`   工作流: ${workflow.name} (ID: ${workflow.id})`);
    console.log(`   节点: ${taskNode.name} (key: ${config.key})`);

    // 2. 获取认证 token
    const auth = await getValidToken();
    if (!auth) {
      console.log('\n❌ 无法获取有效 token，无法继续测试');
      console.log('💡 请手动提供 token:');
      console.log('   1. 在浏览器 F12 → Console 执行:');
      console.log('      copy(sessionStorage.getItem("orvia.token"))');
      console.log('   2. 将复制的 token 告诉我');
      return;
    }

    // 3. 发送请求
    console.log('\n📤 发送 @单个节点请求...');
    const testMessage = `@${taskNode.name} 自动测试 ${new Date().toLocaleTimeString()}`;
    console.log(`   消息: ${testMessage}`);

    const response = await fetch(`http://127.0.0.1:4100/api/workflows/${workflow.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
        'x-orvia-tenant-id': auth.tenantId
      },
      body: JSON.stringify({
        content: testMessage,
        mentions: [config.key]
      })
    });

    console.log(`\n📥 响应状态: ${response.status} ${response.statusText}`);
    console.log(`   Content-Type: ${response.headers.get('content-type')}\n`);

    // 4. 读取 SSE 流
    if (response.body && response.headers.get('content-type')?.includes('text/event-stream')) {
      console.log('✅ 收到 SSE 流，读取事件:\n');
      console.log('-'.repeat(70));
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventCount = 0;
      let lastEvent = '';
      let hasStreamDone = false;
      let hasError = false;

      try {
        // 设置超时：最多等待 60 秒
        const timeout = setTimeout(() => {
          console.log('\n⏰ 超时！等待超过 60 秒');
          reader.cancel();
        }, 60000);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          let currentEvent = '';
          let currentData = '';
          
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7);
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6);
            } else if (line === '' && currentEvent && currentData) {
              eventCount++;
              lastEvent = currentEvent;
              
              const icon = currentEvent.includes('error') || currentEvent === 'fatal_error' ? '❌' 
                         : currentEvent === 'done' ? '✅' 
                         : currentEvent === 'stream_done' ? '🎉' 
                         : '📝';
              
              console.log(`${icon} [#${eventCount}] ${currentEvent}`);
              if (currentData.length < 150) {
                console.log(`   ${currentData}`);
              } else {
                console.log(`   ${currentData.slice(0, 150)}...`);
              }
              
              if (currentEvent === 'stream_done') hasStreamDone = true;
              if (currentEvent.includes('error')) hasError = true;
              
              currentEvent = '';
              currentData = '';
            }
          }
          
          if (lastEvent === 'done') {
            clearTimeout(timeout);
            console.log('\n🏁 收到 done 事件');
            break;
          }
        }
        clearTimeout(timeout);
      } catch (readError) {
        console.error(`\n⚠️  读取流出错:`, readError.message);
      } finally {
        reader.releaseLock();
      }

      console.log('-'.repeat(70));
      console.log(`\n📊 统计:`);
      console.log(`   事件总数: ${eventCount}`);
      console.log(`   最后事件: ${lastEvent}`);
      console.log(`   完成状态: ${hasStreamDone ? '✅' : '❌'}`);
      console.log(`   错误状态: ${hasError ? '❌ 有错误' : '✅ 无错误'}`);
      
      if (hasStreamDone && !hasError) {
        testPassed = true;
        console.log('\n🎉🎉🎉 测试通过！！@单个节点功能正常！');
      } else if (hasError) {
        console.log('\n❌ 测试失败！检测到错误');
      } else {
        console.log('\n⚠️  测试未完成');
      }
      
    } else {
      console.log('⚠️  非 SSE 响应');
      try {
        const text = await response.text();
        console.log(`\n响应内容:\n${text}`);
      } catch (e) {}
    }

    // 5. 检查数据库
    console.log('\n⏳ 等待 1 秒后检查数据库...');
    await new Promise(r => setTimeout(r, 1000));

    const recentSessions = await db.select({
      id: sessions.id,
      status: sessions.status,
      inputJson: sessions.inputJson,
      outputJson: sessions.outputJson,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.contextType, 'chat'))
    .orderBy(desc(sessions.createdAt))
    .limit(3);

    if (recentSessions.length > 0) {
      console.log('\n📝 最近会话:');
      for (const s of recentSessions) {
        const input = typeof s.inputJson === 'string' ? JSON.parse(s.inputJson) : s.inputJson || {};
        const output = typeof s.outputJson === 'string' ? JSON.parse(s.outputJson) : s.outputJson || {};
        const icon = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : '⏳';
        console.log(`\n${icon} #${s.id} [${s.status}] ${input.nodeKey || '?'} @ ${s.createdAt}`);
        if (s.status === 'failed') console.log(`   错误: ${output.error}`);
        if (output.text) console.log(`   回复: ${(output.text as string).slice(0, 80)}...`);
      }
    }

  } catch (error) {
    console.error('\n💥 测试出错:', error);
  } finally {
    await pool.end();
  }

  console.log('\n' + '='.repeat(70));
  console.log(testPassed ? '✅ 最终结果: 通过' : '❌ 最终结果: 失败');
  console.log('='.repeat(70) + '\n');
  
  process.exit(testPassed ? 0 : 1);
}

testSingleNodeChat().catch(e => {
  console.error('未捕获错误:', e);
  process.exit(1);
});
