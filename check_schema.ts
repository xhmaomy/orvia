import { pool } from './src/db/client.js';

async function checkSchema() {
  try {
    const [rows] = await pool.query('DESCRIBE ov_model_providers');
    console.log('ov_model_providers 表结构:');
    console.log(rows);
  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}
checkSchema();
