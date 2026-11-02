import { db, pool } from './src/db/client.js';
import { modelProviders } from './src/db/schema.js';
import { eq } from 'drizzle-orm';

async function checkProviders() {
  console.log('\n🔍 === 检查模型 Provider 配置 ===\n');

  try {
    const providers = await db.select().from(modelProviders);

    if (providers.length === 0) {
      console.log('❌ 没有找到任何 Provider 配置');
      return;
    }

    console.log(`📊 找到 ${providers.length} 个 Provider:\n`);

    for (const provider of providers) {
      const config = typeof provider.configJson === 'string'
        ? JSON.parse(provider.configJson)
        : provider.configJson || {};

      const hasApiKey = config && config.apiKey;
      const apiKeyPreview = hasApiKey
        ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`
        : '❌ 未配置';

      console.log('='.repeat(60));
      console.log(`Provider: ${provider.name} (ID: ${provider.id})`);
      console.log(`类型: ${provider.type}`);
      console.log(`API Key: ${apiKeyPreview}`);
      console.log(`是否启用: ${provider.isEnabled ? '✅ 是' : '❌ 否'}`);
      
      if (!hasApiKey) {
        console.log(`\n⚠️  问题: 该 Provider 没有配置 API Key!`);
        console.log(`💡 解决: 请到「模型管理」页面编辑该 Provider 并填写 API Key`);
      }

      console.log('\n');
    }

  } catch (error) {
    console.error('❌ 检查过程中出错:', error);
  } finally {
    await pool.end();
  }

  console.log('✨ 检查完成\n');
}

checkProviders();
