const test = require('node:test');
const assert = require('node:assert/strict');
const database = require('../config/database');
test('translates positional parameters into MySQL placeholders', () => {
    const result = database.translatePlaceholders('SELECT $2, $1, $2', ['first', 'second']);
    assert.equal(result.sql, 'SELECT ?, ?, ?');
    assert.deepEqual(result.values, ['second', 'first', 'second']);
});

test('translates legacy search, date formatting, and cast syntax for MySQL', () => {
    const sql = database.translateSql(`
        SELECT name ILIKE $1, TO_CHAR(created_at, 'FMDD-FMMM-YYYY')
        FROM leads
        WHERE created_at::date = $2::date AND CAST(id AS TEXT) = $3
    `);
    assert.match(sql, /name LIKE \$1/);
    assert.match(sql, /DATE_FORMAT\(created_at, '%e-%c-%Y'\)/);
    assert.match(sql, /created_at = \$2/);
    assert.match(sql, /CAST\(id AS CHAR\)/);
});

test('uses a callback-compatible MySQL pool for Express session storage', () => {
    assert.equal(typeof database.sessionPool.query, 'function');
    assert.equal(typeof database.sessionPool.promise, 'function');
});
