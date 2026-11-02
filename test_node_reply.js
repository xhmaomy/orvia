import { db, pool } from './src/db/client.js';
import { sessions, nodeMessages } from './src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

async function checkRecentSessions() {
  console.log('\n🔍 === 检查最近的节点聊天会话 ===\n');

  try {
    const recentSessions = await db.select({
      id: sessions.id,
      contextType: sessions.contextType,
      status: sessions.status,
      runtime: sessions.runtime,
      inputJson: sessions.inputJson,
      outputJson: sessions.outputJson,
      createdAt: sessions.createdAt,
      completedAt: sessions.completedAt,
    })
    .from(sessions)
    .where(eq(sessions.contextType, 'chat'))
    .orderBy(desc(sessions.createdAt))
    .limit(10);

    if (recentSessions.length === 0) {
      console.log('❌ 没有找到任何聊天会话记录');
      return;
    }

    console.log(`📊 找到 ${recentSessions.length} 个最近的聊天会话:\n`);

    for (const session of recentSessions) {
      const input = typeof session.inputJson === 'string'
        ? JSON.parse(session.inputJson)
        : session.inputJson || {};

      const output = typeof session.outputJson === 'string'
        ? JSON.parse(session.outputJson)
        : session.outputJson || {};

      console.log('='.repeat(70));
      console.log(`会话 ID: ${session.id}`);
      console.log(`状态: ${session.status}`);
      console.log(`运行时: ${session.runtime}`);
      console.log(`节点 Key: ${input.nodeKey || '未知'}`);
      console.log(`创建时间: ${session.createdAt}`);
      console.log(`完成时间: ${session.completedAt || '未完成'}`);
      console.log(`输入: ${(input.prompt || '').slice(0, 100)}...`);
      console.log(`输出: ${JSON.stringify(output).slice(0, 100)}...`);

      if (session.status === 'failed') {
        console.log(`\n⚠️  该会话失败！错误信息:`);
        console.log(`   ${JSON.stringify(output, null, 2)}`);
      }

      const messages = await db.select({
        content: nodeMessages.content,
        thinking: nodeMessages.thinking,
        status: nodeMessages.status,
      })
      .from(nodeMessages)
      .where(eq(nodeMessages.sessionId, session.id))
      .limit(3);

      if (messages.length > 0) {
        console.log(`\n📝 关联的消息 (${messages.length} 条):`);
        for (const msg of messages) {
          console.log(`   - 状态: ${msg.status}`);
          console.log(`     内容: ${(msg.content || '(空)').slice(0, 80)}...`);
          if (msg.thinking) {
            console.log(`     思考: ${msg.thinking.slice(0, 80)}...`);
          }
        }
      }

      console.log('\n');
    }

  } catch (error) {
    console.error('❌ 检查过程中出错:', error);
  } finally {
    await pool.end();
  }

  console.log('\n✨ 检查完成\n');
}

checkRecentSessions();
