const mysql = require('mysql2/promise');
const mysqlCallback = require('mysql2');

require('dotenv').config();

const sslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const mysqlOptions = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_MAX || 10),
    connectTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
    maxIdle: Number(process.env.DB_POOL_MAX || 10),
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    enableKeepAlive: true,
    ssl: sslEnabled
        ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' }
        : undefined,
    timezone: 'Z',
    dateStrings: ['DATE']
};
const mysqlPool = mysql.createPool(mysqlOptions);
const sessionPool = mysqlCallback.createPool(mysqlOptions);

function translatePlaceholders(sql, values = []) {
    const orderedValues = [];
    const translatedSql = sql.replace(/\$(\d+)/g, (_match, index) => {
        const valueIndex = Number(index) - 1;
        if (valueIndex < 0 || valueIndex >= values.length) {
            throw new Error(`Parameter SQL $${index} tidak memiliki nilai.`);
        }
        orderedValues.push(values[valueIndex]);
        return '?';
    });

    return {
        sql: translatedSql,
        values: orderedValues.length ? orderedValues : values
    };
}

function translateSql(sql) {
    return sql
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/\bBTRIM\s*\(/gi, 'TRIM(')
        .replace(/TO_CHAR\(([^,()]+),\s*'DD-MM-YYYY HH24:MI'\)/gi, "DATE_FORMAT($1, '%d-%m-%Y %H:%i')")
        .replace(/TO_CHAR\(([^,()]+),\s*'DD\/MM\/YYYY HH24:MI'\)/gi, "DATE_FORMAT($1, '%d/%m/%Y %H:%i')")
        .replace(/TO_CHAR\(([^,()]+),\s*'FMDD-FMMM-YYYY'\)/gi, "DATE_FORMAT($1, '%e-%c-%Y')")
        .replace(/TO_CHAR\(([^,()]+),\s*'FMDD\/FMMM\/YYYY'\)/gi, "DATE_FORMAT($1, '%e/%c/%Y')")
        .replace(/TO_CHAR\(([^,()]+),\s*'FMDD\.FMMM\.YYYY'\)/gi, "DATE_FORMAT($1, '%e.%c.%Y')")
        .replace(/TO_CHAR\(([^,()]+),\s*'FMDD'\)/gi, "DATE_FORMAT($1, '%e')")
        .replace(/TO_CHAR\(([^,()]+),\s*'YYYY HH24:MI'\)/gi, "DATE_FORMAT($1, '%Y %H:%i')")
        .replace(/TO_CHAR\(([^,()]+),\s*'DD-MM-YYYY'\)/gi, "DATE_FORMAT($1, '%d-%m-%Y')")
        .replace(/TO_CHAR\(([^,()]+),\s*'DD'\)/gi, "DATE_FORMAT($1, '%d')")
        .replace(/TO_CHAR\(([^,()]+),\s*'YYYY'\)/gi, "DATE_FORMAT($1, '%Y')")
        .replace(/::(?:uuid|jsonb|text|int|date)\b/gi, '')
        .replace(/\bTIMESTAMPTZ\b/gi, 'DATETIME')
        .replace(/\bJSONB\b/gi, 'JSON')
        .replace(/\bBIGSERIAL\b/gi, 'BIGINT AUTO_INCREMENT')
        .replace(/CAST\(([^()]+)\s+AS\s+TEXT\)/gi, 'CAST($1 AS CHAR)');
}

async function queryWith(connection, sql, values = []) {
    const returningMatch = sql.match(/\s+RETURNING\s+([\s\S]*?)\s*;?\s*$/i);
    const statement = returningMatch ? sql.slice(0, returningMatch.index).trim().replace(/;$/, '') : sql;
    const translated = translatePlaceholders(translateSql(statement), values);
    let operation;
    let tableName;
    let returningColumns;
    let ids = [];
    let deletedRows = [];

    if (returningMatch) {
        operation = statement.match(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+`?([a-z_][a-z0-9_]*)`?/i);
        if (!operation) {
            throw new Error('RETURNING MySQL tidak didukung untuk bentuk query ini.');
        }
        tableName = operation[2];
        returningColumns = returningMatch[1].trim();

        if (/^\s*(?:DELETE|UPDATE)/i.test(statement)) {
            const whereMatch = statement.match(/\bWHERE\b([\s\S]*)$/i);
            if (whereMatch) {
                const whereValues = [];
                const whereSql = translateSql(whereMatch[1]).replace(/\$(\d+)/g, (_match, index) => {
                    const valueIndex = Number(index) - 1;
                    if (valueIndex < 0 || valueIndex >= values.length) {
                        throw new Error(`Parameter SQL $${index} tidak memiliki nilai.`);
                    }
                    whereValues.push(values[valueIndex]);
                    return '?';
                });
                const selectColumns = /^\s*DELETE/i.test(statement) ? returningColumns : 'id';
                const [selectedRows] = await connection.execute(
                    `SELECT ${selectColumns} FROM \`${tableName}\` WHERE ${whereSql} FOR UPDATE`,
                    whereValues
                );
                ids = selectedRows.map(row => row.id).filter(id => id !== undefined);
                if (/^\s*DELETE/i.test(statement)) deletedRows = selectedRows;
            }
        }
    }

    const [result] = translated.values.length
        ? await connection.execute(translated.sql, translated.values)
        : await connection.query(translated.sql);

    if (returningMatch) {
        let rows = deletedRows;
        if (/^\s*UPDATE/i.test(statement) && ids.length) {
            const [updatedRows] = await connection.execute(
                `SELECT ${returningColumns} FROM \`${tableName}\` WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            rows = updatedRows;
        } else if (/^\s*INSERT/i.test(statement)) {
            let insertedId = result.insertId;
            const insertValues = statement.match(/INSERT\s+INTO\s+`?[a-z_][a-z0-9_]*`?\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]*?)\)/i);
            if (insertValues) {
                const columns = insertValues[1].split(',').map(column => column.trim().replace(/[`"]/g, '').toLowerCase());
                const idIndex = columns.indexOf('id');
                if (idIndex >= 0) {
                    const idExpression = insertValues[2].split(',')[idIndex]?.trim();
                    const idPlaceholder = idExpression?.match(/^\$(\d+)$/);
                    if (idPlaceholder) insertedId = values[Number(idPlaceholder[1]) - 1];
                }
            }
            if (insertedId) {
                const [insertedRows] = await connection.execute(
                    `SELECT ${returningColumns} FROM \`${tableName}\` WHERE id = ?`,
                    [insertedId]
                );
                rows = insertedRows;
            }
        }

        return {
            rows,
            rowCount: rows.length || result.affectedRows || 0,
            insertId: result.insertId || 0,
            warningStatus: result.warningStatus || 0
        };
    }

    if (Array.isArray(result)) {
        return { rows: result, rowCount: result.length };
    }

    return {
        rows: [],
        rowCount: result.affectedRows || 0,
        insertId: result.insertId || 0,
        warningStatus: result.warningStatus || 0
    };
}

const pool = {
    query(sql, values) {
        if (/\bRETURNING\b/i.test(sql)) {
            return mysqlPool.getConnection().then(async connection => {
                try {
                    await connection.beginTransaction();
                    const result = await queryWith(connection, sql, values);
                    await connection.commit();
                    return result;
                } catch (error) {
                    await connection.rollback();
                    throw error;
                } finally {
                    connection.release();
                }
            });
        }
        return queryWith(mysqlPool, sql, values);
    },

    async connect() {
        const connection = await mysqlPool.getConnection();
        return {
            query(sql, values) {
                return queryWith(connection, sql, values);
            },
            release() {
                connection.release();
            }
        };
    },

    async waitForDatabase() {
        const startupRetries = Number(process.env.DB_STARTUP_RETRIES || 10);
        const startupRetryDelayMs = Number(process.env.DB_STARTUP_RETRY_DELAY_MS || 2000);

        for (let attempt = 1; attempt <= startupRetries; attempt += 1) {
            try {
                await mysqlPool.query('SELECT 1');
                console.log('✅ MySQL berhasil terhubung');
                return;
            } catch (error) {
                const message = error.code ? `${error.code}: ${error.message}` : error.message;
                if (attempt === startupRetries) {
                    throw new Error(`MySQL belum siap setelah ${startupRetries} percobaan: ${message}`);
                }
                console.warn(`⏳ MySQL belum siap (percobaan ${attempt}/${startupRetries}). Coba lagi dalam ${startupRetryDelayMs} ms.`);
                await new Promise(resolve => setTimeout(resolve, startupRetryDelayMs));
            }
        }
    },

    end() {
        return Promise.all([mysqlPool.end(), sessionPool.promise().end()]);
    },

    on(event, listener) {
        mysqlPool.on(event, listener);
        return this;
    }
};

mysqlPool.on('connection', connection => {
    connection.promise().query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')").catch(error => {
        console.error('[Database] Gagal menyiapkan mode kompatibilitas MySQL:', error.message);
        connection.destroy();
    });
});

pool.raw = mysqlPool;
pool.sessionPool = sessionPool;
pool.translateSql = translateSql;
pool.translatePlaceholders = translatePlaceholders;

module.exports = pool;
