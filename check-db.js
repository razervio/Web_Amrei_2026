require('dotenv').config();
const pool = require('./config/database');

async function checkDatabase() {
    try {
        await pool.waitForDatabase();
        const result = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'leads'
            ORDER BY ordinal_position
        `);

        console.log('=== STRUKTUR TABEL LEADS ===');
        result.rows.forEach(row => console.log(`${row.column_name}: ${row.data_type}`));

        const sample = await pool.query(`
            SELECT id, nama, no_wa, jenis_kelamin, domisili, tgl_lahir
            FROM leads
            LIMIT 2
        `);
        console.log('\n=== SAMPLE DATA ===');
        console.log(JSON.stringify(sample.rows, null, 2));
    } catch (error) {
        console.error('Gagal memeriksa MySQL:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

checkDatabase();
