const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const pool = require("./config/database");

async function migrate() {
    try {
        const properties = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, "data", "properties.json"),
                "utf8"
            )
        );

        for (const p of properties) {
            await pool.query(
                `
                INSERT INTO properties
(id, nama, lokasi, tipe, harga, deskripsi, thumbnail, images)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                `,
               [
    randomUUID(),
    p.nama,
    p.lokasi,
    p.tipe,
    p.harga,
    p.deskripsi,
     p.foto,  
    JSON.stringify(p.images || [])
]
            );
        }

        console.log(`✅ ${properties.length} properties berhasil dipindahkan.`);
    } catch (err) {
        console.error(err);
    }

    process.exit();
}

migrate();