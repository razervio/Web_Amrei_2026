require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

async function checkTable() {
    try {
        // Check struktur leads table
        const result = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'leads'
            ORDER BY ordinal_position;
        `);
        
        console.log("=== STRUKTUR TABEL LEADS ===");
        result.rows.forEach(row => {
            console.log(`${row.column_name}: ${row.data_type}`);
        });
        
        // Check sample data
        console.log("\n=== SAMPLE DATA ===");
        const sampleResult = await pool.query(`
            SELECT id, nama, no_wa, jenis_kelamin, domisili, tgl_lahir
            FROM leads
            LIMIT 2;
        `);
        
        console.log(JSON.stringify(sampleResult.rows, null, 2));
        
        await pool.end();
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTable();
