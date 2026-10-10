import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import * as schema from './schema.js';

const pool = mysql.createPool(config.databaseUrl);

export const db = drizzle(pool, { schema, mode: 'default' });
export { pool };

