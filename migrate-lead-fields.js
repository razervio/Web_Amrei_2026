require('dotenv').config();
const pool = require('./config/database');

async function migrate() {
    try {
        await pool.query(`
            ALTER TABLE leads
                ADD COLUMN IF NOT EXISTS email TEXT,
                ADD COLUMN IF NOT EXISTS tanggal_pernikahan DATE,
                ADD COLUMN IF NOT EXISTS customer_service TEXT,
                ADD COLUMN IF NOT EXISTS jenis_konsumen TEXT,
                ADD COLUMN IF NOT EXISTS pekerjaan TEXT,
                ADD COLUMN IF NOT EXISTS keterangan TEXT
        `);
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'leads' AND column_name = 'kategori'
                ) THEN
                    UPDATE leads
                    SET customer_service = COALESCE(NULLIF(customer_service, ''), kategori)
                    WHERE kategori IS NOT NULL;
                    ALTER TABLE leads DROP COLUMN kategori;
                END IF;
            END $$;
        `);
        await pool.query(`
            ALTER TABLE leads
                DROP COLUMN IF EXISTS marketer_name,
                DROP COLUMN IF EXISTS type
        `);
        console.log('Kolom Customer Service sudah dikonsolidasikan dari kategori.');
    } catch (error) {
        console.error('Gagal menyiapkan kolom lead:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

migrate();
