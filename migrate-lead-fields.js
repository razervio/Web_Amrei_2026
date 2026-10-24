require('dotenv').config();
const pool = require('./config/database');

async function ensureColumn(name, definition) {
    const existing = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'leads' AND column_name = ?`,
        [name]
    );
    if (!existing.rows.length) {
        await pool.query(`ALTER TABLE leads ADD COLUMN \`${name}\` ${definition}`);
    }
}

async function migrate() {
    try {
        const columns = {
            email: 'TEXT NULL',
            tanggal_pernikahan: 'DATE NULL',
            customer_service: 'TEXT NULL',
            jenis_konsumen: 'TEXT NULL',
            pekerjaan: 'TEXT NULL',
            keterangan: 'TEXT NULL'
        };
        for (const [name, definition] of Object.entries(columns)) {
            await ensureColumn(name, definition);
        }

        const kategori = await pool.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'leads' AND column_name = 'kategori'`
        );
        if (kategori.rows.length) {
            await pool.query(`
                UPDATE leads
                SET customer_service = COALESCE(NULLIF(customer_service, ''), kategori)
                WHERE kategori IS NOT NULL
            `);
        }
        console.log('Kolom lead MySQL sudah disiapkan; data kategori lama tetap dipertahankan.');
    } catch (error) {
        console.error('Gagal menyiapkan kolom lead:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

migrate();
