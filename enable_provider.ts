import { pool } from './src/db/client.js';

async function enableMiniMax() {
  console.log('\n🔧 === 启用 MiniMax Provider ===\n');

  try {
    // 先查看当前状态
    const [rows] = await pool.query(
      'SELECT id, name, status FROM ov_model_providers WHERE id = 1'
    );
    console.log('当前状态:', rows[0]);
    
    // 更新为 active
    const [result] = await pool.query(
      "UPDATE ov_model_providers SET status = 'active' WHERE id = 1"
    );
    
    console.log(`\n✅ 更新成功！影响行数: ${(result as any).affectedRows}`);
    
    // 验证更新
    const [updated] = await pool.query(
      "SELECT id, name, status FROM ov_model_providers WHERE id = 1"
    );
    console.log('更新后状态:', updated[0]);
    
    console.log('\n🎉 MiniMax Provider 已启用！');
    console.log('\n📝 下一步操作:');
    console.log('   1. 重启后端服务器 (在运行 server.ts 的终端按 Ctrl+C)');
    console.log('   2. 运行: pnpm dev');
    console.log('   3. 在聊天中 @任意 task 节点测试');
    console.log('   4. 观察是否正常收到 AI 回复');

  } catch (error) {
    console.error('❌ 启用失败:', error);
  } finally {
    await pool.end();
  }

  console.log('\n');
}

enableMiniMax();
