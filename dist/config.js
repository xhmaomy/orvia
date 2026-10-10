import 'dotenv/config';
const port = Number(process.env.PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}
const nodeEnv = process.env.NODE_ENV ?? 'development';
const apiToken = process.env.ORVIA_API_TOKEN?.trim() || undefined;
if (nodeEnv === 'production' && !apiToken) {
    throw new Error('ORVIA_API_TOKEN is required when NODE_ENV=production');
}
export const config = {
    nodeEnv,
    port,
    host: process.env.HOST ?? '127.0.0.1',
    databaseUrl: process.env.DATABASE_URL,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    piCommand: process.env.PI_COMMAND ?? 'pi',
    apiToken,
    maxBodyBytes: 1_000_000,
};
