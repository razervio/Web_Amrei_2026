const { Pool, types } = require("pg");

require("dotenv").config();

// Parser untuk kolom DATE
types.setTypeParser(1082, value => value);

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: Number(process.env.DB_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' }
        : undefined
});

const startupRetries = Number(process.env.DB_STARTUP_RETRIES || 10);
const startupRetryDelayMs = Number(process.env.DB_STARTUP_RETRY_DELAY_MS || 2000);

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForDatabase() {
    for (let attempt = 1; attempt <= startupRetries; attempt += 1) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ PostgreSQL berhasil terhubung');
            return;
        } catch (error) {
            const message = error.code ? `${error.code}: ${error.message}` : error.message;

            if (attempt === startupRetries) {
                throw new Error(`PostgreSQL belum siap setelah ${startupRetries} percobaan: ${message}`);
            }

            console.warn(`⏳ PostgreSQL belum siap (percobaan ${attempt}/${startupRetries}). Coba lagi dalam ${startupRetryDelayMs} ms.`);
            await delay(startupRetryDelayMs);
        }
    }
}

pool.on('error', error => {
    console.error('❌ PostgreSQL pool error:', error.code || error.message);
});

pool.waitForDatabase = waitForDatabase;

module.exports = pool;