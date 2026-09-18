const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const pool = require("./config/database");

async function migrate() {
    try {
        const articles = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, "data", "artikel.json"),
                "utf8"
            )
        );

        for (const a of articles) {

            await pool.query(
                `
                INSERT INTO articles
                (id, judul, kategori, ringkasan, isi, thumbnail, tanggal)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                `,
                [
                    randomUUID(),
                    a.judul,
                    a.kategori,
                    a.ringkasan,
                    a.isi,
                    a.thumbnail,
                    a.tanggal
                ]
            );

        }

        console.log(`✅ ${articles.length} artikel berhasil dipindahkan.`);
    }
    catch(err){
        console.error(err);
    }

    process.exit();
}

migrate();