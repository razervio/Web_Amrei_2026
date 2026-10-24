require('dotenv').config();
require("./config/database");
const pool = require("./config/database");
const { randomUUID } = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');

if (process.env.NODE_ENV === 'production' &&
    (!process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET === 'amrei-dev-secret-change-this' ||
        process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET wajib berisi secret acak minimal 32 karakter saat production.');
}
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) {
    throw new Error('APP_ORIGIN wajib diisi saat production untuk validasi Origin request.');
}
if (process.env.NODE_ENV === 'production') {
    const configuredOrigins = process.env.APP_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean);
    try {
        configuredOrigins.forEach(origin => {
            const appOrigin = new URL(origin);
            if (appOrigin.protocol !== 'https:') {
                throw new Error();
            }
        });
    } catch (_error) {
        throw new Error('APP_ORIGIN harus berupa satu atau beberapa URL HTTPS yang valid saat production.');
    }
    if (String(process.env.DB_SSL || '').toLowerCase() !== 'true') {
        throw new Error('DB_SSL=true wajib diisi saat production untuk melindungi koneksi MySQL.');
    }
    if (String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'true') {
        throw new Error('DB_SSL_REJECT_UNAUTHORIZED=true wajib diisi saat production untuk memvalidasi sertifikat MySQL.');
    }
}

process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);

    const isWhatsAppCleanupError =
        message.includes('EBUSY') && message.includes('.wwebjs_auth');
    const isWhatsAppTargetClosedError =
        message.includes('TargetCloseError') ||
        message.includes('Target closed') ||
        message.includes('detached Frame') ||
        message.includes('InvocationInterface was not inited');

    if (
        message.includes('Execution context was destroyed') ||
        isWhatsAppTargetClosedError
    ) {
        console.warn('[WA] Navigasi WhatsApp memutus proses inject sementara.');
        return;
    }

    if (isWhatsAppCleanupError) {
        console.warn('[WA] File sesi masih digunakan Windows; cleanup file tersebut dilewati.');
        return;
    }

    console.error('[Process] Unhandled promise rejection:', reason);
    throw reason;
});

const app = express();
const adminDashboardClients = new Set();
const publicContentClients = new Set();
app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
            scriptSrcAttr: ["'unsafe-inline'"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net']
        }
    },
    crossOriginEmbedderPolicy: false
}));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak permintaan. Coba lagi dalam satu menit.' }
});

const mutationLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak perubahan. Coba lagi dalam satu menit.' }
});

const apiReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    skip: req => !['GET', 'HEAD'].includes(req.method) || req.path === '/admin/dashboard-events',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak permintaan data. Coba lagi dalam satu menit.' }
});

function applicationFirewall(req, res, next) {
    const requestTarget = `${req.originalUrl || ''} ${req.path || ''}`.toLowerCase();
    const blockedPattern = /(?:\.\.[\\/]|%2e%2e|%00|%2f%2f|\.env|\.git(?:[\\/]|$)|wp-admin|wp-login|etc[\\/]passwd|proc[\/]self)/i;

    if (blockedPattern.test(requestTarget)) {
        return res.status(404).end();
    }

    next();
}

app.use(applicationFirewall);
function isPublicReadRequest(req) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;

    return req.path === '/public/content-events' ||
        req.path === '/about' ||
        req.path === '/activity' ||
        req.path === '/marketers' ||
        req.path === '/properties' ||
        req.path === '/properties/all' ||
        req.path === '/artikel' ||
        req.path.startsWith('/artikel/') ||
        req.path.startsWith('/public/marketer/');
}

const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    skip: isPublicReadRequest,
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi satu menit.' }
});

app.use('/api', apiLimiter);
app.use('/api', apiReadLimiter);
app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return mutationLimiter(req, res, next);
    next();
});

function notifyAdminDashboard(event, data = {}) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of adminDashboardClients) {
        try {
            client.write(message);
        } catch (_error) {
            adminDashboardClients.delete(client);
        }
    }
}

function notifyPublicContentChanged(type) {
    const message = `event: content-changed\ndata: ${JSON.stringify({ type })}\n\n`;

    for (const client of publicContentClients) {
        try {
            client.write(message);
        } catch (_error) {
            publicContentClients.delete(client);
        }
    }
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROPERTY_UPLOAD_DIR = path.join(UPLOAD_DIR, 'properties');
const ARTICLE_UPLOAD_DIR = path.join(UPLOAD_DIR, 'artikel');
const MARKETER_DOCUMENT_DIR = path.join(DATA_DIR, 'marketer-documents');
const mailTransporter = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
        requireTLS: String(process.env.SMTP_SECURE || 'false').toLowerCase() !== 'true',
        auth: {
            user: process.env.SMTP_USER?.trim(),
            pass: process.env.SMTP_PASSWORD?.replace(/\s/g, '')
        }
    })
    : null;

async function ensureLeadColumns() {
    await ensureColumns('leads', {
        email: 'TEXT NULL',
        tanggal_pernikahan: 'DATE NULL',
        customer_service: 'TEXT NULL',
        jenis_konsumen: 'TEXT NULL',
        pekerjaan: 'TEXT NULL',
        keterangan: 'TEXT NULL'
    });
}

async function ensureUserNoticeColumns() {
    await ensureColumns('users', {
        status_login_notice_sent_for: 'TEXT NULL',
        keterangan: 'TEXT NULL',
        nik: 'TEXT NULL',
        nomor_rekening: 'TEXT NULL',
        foto_marketer: 'TEXT NULL',
        foto_ktp: 'TEXT NULL'
    });
}

async function ensureColumns(tableName, columns) {
    for (const [columnName, definition] of Object.entries(columns)) {
        const existing = await pool.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
            [tableName, columnName]
        );
        if (!existing.rows.length) {
            await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
        }
    }
}

async function ensureMessageTemplatesTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS message_templates (
            id CHAR(36) NOT NULL PRIMARY KEY,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            scope VARCHAR(32) NOT NULL,
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const index = await pool.query(
        `SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'message_templates'
           AND index_name = 'message_templates_scope_created_by_idx'`
    );
    if (!index.rows.length) {
        await pool.query(`
            CREATE INDEX message_templates_scope_created_by_idx
            ON message_templates (scope(32), created_by(191))
        `);
    }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PROPERTY_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTICLE_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(MARKETER_DOCUMENT_DIR, { recursive: true });


app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 100 }));
app.use('/uploads/properties', express.static(PROPERTY_UPLOAD_DIR));
app.use('/uploads/artikel', express.static(ARTICLE_UPLOAD_DIR));
const sessionStore = new MySQLStore({
    clearExpired: false,
    createDatabaseTable: true,
    endConnectionOnClose: false,
    schema: {
        tableName: 'sessions',
        columnNames: {
            session_id: 'session_id',
            expires: 'expires',
            data: 'data'
        }
    }
}, pool.sessionPool);

app.use(session({
    secret: process.env.SESSION_SECRET || 'amrei-dev-secret-change-this',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }

    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const configuredOrigins = (process.env.APP_ORIGIN || '')
        .split(',')
        .map(value => value.trim().replace(/\/$/, ''))
        .filter(Boolean);
    const requestHostOrigin = `${req.protocol}://${req.get('host')}`;
    const expectedOrigins = process.env.NODE_ENV === 'production'
        ? configuredOrigins
        : [...new Set([...configuredOrigins, requestHostOrigin])];
    const origin = req.get('origin');
    const referer = req.get('referer');
    const requestOrigins = [];
    if (origin !== undefined) {
        if (!origin.trim()) {
            return res.status(403).json({ success: false, message: 'Origin request tidak diizinkan.' });
        }
        requestOrigins.push(origin.trim());
    }
    if (referer !== undefined) {
        if (!referer.trim()) {
            return res.status(403).json({ success: false, message: 'Origin request tidak diizinkan.' });
        }
        try {
            requestOrigins.push(new URL(referer).origin);
        } catch (_error) {
            return res.status(403).json({ success: false, message: 'Origin request tidak diizinkan.' });
        }
    }

    if (requestOrigins.length === 0 || requestOrigins.some(requestOrigin => !expectedOrigins.includes(requestOrigin))) {
        return res.status(403).json({ success: false, message: 'Origin request tidak diizinkan.' });
    }

    next();
});

function protectedPageHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

app.get('/admin-dashboard.html', (req, res, next) => {
    protectedPageHeaders(res);
    if (req.session.user?.role !== 'admin') {
        return res.redirect('/login.html');
    }
    next();
}, express.static(path.join(__dirname, 'public')));

app.get('/marketer-dashboard.html', (req, res, next) => {
    protectedPageHeaders(res);
    if (req.session.user?.role !== 'marketer') {
        return res.redirect('/login.html');
    }
    next();
}, express.static(path.join(__dirname, 'public')));

app.get('/login.html', (req, res, next) => {
    protectedPageHeaders(res);
    next();
}, express.static(path.join(__dirname, 'public')));

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => cb(null, `customers-${Date.now()}${path.extname(file.originalname)}`)
    }),
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, ['.xlsx', '.xls'].includes(ext));
    },
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, parts: 25 }
});

const propertyUpload = multer({
    storage: multer.diskStorage({
        destination: PROPERTY_UPLOAD_DIR,
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `property-${Date.now()}${ext}`);
        }
    }),

    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Format foto harus JPG, JPEG, PNG, atau WEBP.'));
        }
    },

    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 15,
        fields: 30,
        parts: 50
    }
}).fields([
    { name: 'foto', maxCount: 15 },
    { name: 'images', maxCount: 15 },
    { name: 'thumbnail', maxCount: 1 }
]);

const marketerUpload = multer({
    storage: multer.diskStorage({
        destination: MARKETER_DOCUMENT_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `marketer-${req.params.id || 'new'}-${file.fieldname}-${Date.now()}${ext}`);
        }
    }),
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            return cb(null, true);
        }
        cb(new Error('Format foto harus JPG, JPEG, PNG, atau WEBP.'));
    },
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 2,
        fields: 20,
        parts: 25
    }
}).fields([
    { name: 'foto_marketer', maxCount: 1 },
    { name: 'foto_ktp', maxCount: 1 }
]);

function removeMarketerDocument(filename) {
    if (!filename) return;
    const safeName = path.basename(filename);
    fs.rm(path.join(MARKETER_DOCUMENT_DIR, safeName), { force: true }, error => {
        if (error) console.warn('[Marketer] Gagal menghapus dokumen lama:', error.message);
    });
}

function getMarketerFile(req, fieldName) {
    return req.files?.[fieldName]?.[0] || null;
}

const articleUpload = multer({
    storage: multer.diskStorage({
        destination: ARTICLE_UPLOAD_DIR,
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `article-${Date.now()}${ext}`);
        }
    }),

    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Format gambar harus JPG, JPEG, PNG, atau WEBP.'));
        }
    },

    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 20,
        parts: 25
    }
});

const fileSignatures = {
    image: buffer => (
        (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && 'image') ||
        (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && 'image') ||
        (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' && 'image')
    ),
    spreadsheet: buffer => (
        (buffer.subarray(0, 2).toString() === 'PK' && 'spreadsheet') ||
        (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) && 'spreadsheet')
    )
};

function secureUpload(uploadMiddleware, kind) {
    return (req, res, next) => {
        uploadMiddleware(req, res, async error => {
            if (error) return next(error);

            const files = [
                ...(req.file ? [req.file] : []),
                ...Object.values(req.files || {}).flat()
            ];
            const signatureCheck = fileSignatures[kind];

            try {
                for (const file of files) {
                    const header = await fs.promises.readFile(file.path, { encoding: null });
                    if (!signatureCheck(header.subarray(0, 16))) {
                        await Promise.all(files.map(item => fs.promises.rm(item.path, { force: true })));
                        return res.status(400).json({ success: false, message: 'Isi file tidak sesuai dengan format yang diizinkan.' });
                    }
                }
                next();
            } catch (validationError) {
                await Promise.all(files.map(item => fs.promises.rm(item.path, { force: true })));
                console.error('[Upload] Gagal memvalidasi file:', validationError.message);
                return res.status(400).json({ success: false, message: 'File upload tidak dapat divalidasi.' });
            }
        });
    };
}

const secureSpreadsheetUpload = secureUpload(upload.single('file_excel'), 'spreadsheet');
const securePropertyUpload = secureUpload(propertyUpload, 'image');
const secureMarketerUpload = secureUpload(marketerUpload, 'image');
const secureArticleUpload = secureUpload(articleUpload.single('thumbnail'), 'image');

function normalizePropertyImageList(value) {
    if (!value) return [];

    if (Array.isArray(value)) {
        return value.filter(Boolean);
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.filter(Boolean);
            }

            if (parsed) {
                return [parsed];
            }
        } catch (_err) {
            return value
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function getPropertyImagePaths(files) {
    if (!Array.isArray(files)) return [];

    return files.map(file => `/uploads/properties/${file.filename}`);
}

function getUploadedPropertyFiles(req) {
    const files = req.files || {};
    const normalizedFiles = [];

    ['foto', 'images', 'thumbnail'].forEach(fieldName => {
        const fieldFiles = files[fieldName];

        if (!fieldFiles) return;

        normalizedFiles.push(...(Array.isArray(fieldFiles) ? fieldFiles : [fieldFiles]));
    });

    return normalizedFiles;
}

function deletePropertyImageFiles(imagePaths = []) {
    const uniquePaths = [...new Set(imagePaths.filter(Boolean))];

    uniquePaths.forEach(imagePath => {
        const fullPath = path.join(__dirname, 'public', imagePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    });
}

let latestExcelPath = path.join(DATA_DIR, 'customers.xlsx');

// ---------- Excel Sync Helpers ----------

function normalizePhone(value) {
    if (!value) return '';

    let phone = String(value).replace(/\D/g, '');

    if (phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
    }

    if (phone.startsWith('8')) {
        phone = '62' + phone;
    }

    return phone;
}

async function findExistingLeadByPhone(phoneValue) {
    const result = await pool.query(`SELECT * FROM leads`);

    const normalizedTarget = normalizePhone(phoneValue);

    return result.rows.find(lead => {
        const leadPhone = normalizePhone(lead.no_wa);
        return leadPhone && leadPhone === normalizedTarget;
    }) || null;
}

async function writeLeadsToExcel() {
    try {
        let rows = [];
        const leadResult = await pool.query(`
    SELECT *
    FROM leads
    ORDER BY created_at ASC
`);
const leads = leadResult.rows;

        // ==========================================
        // FORMAT KOLOM EXCEL = SAMA DENGAN LEADS
        // ==========================================
        const headers = [
            'Nama',
            'No. WA',
            'Email',
            'Tanggal Lahir',
            'Tanggal Pernikahan',
            'Jenis Kelamin',
            'Domisili',
            'Pekerjaan',
            'Marketer',
            'Properti',
            'Jenis',
            'Status',
            'Tanggal Tanya/Booking'
        ];

        // ==========================================
        // BACA EXCEL YANG SUDAH ADA
        // ==========================================
        if (latestExcelPath && fs.existsSync(latestExcelPath)) {
            const wb = XLSX.readFile(latestExcelPath, {
                cellDates: true
            });

            const ws = wb.Sheets[wb.SheetNames[0]];

            rows = XLSX.utils.sheet_to_json(ws, {
                defval: ''
            });
        }

        // ==========================================
        // SINKRONKAN DATA LEADS KE EXCEL
        // ==========================================
        leads.forEach(lead => {
            const leadName = String(
                lead.nama || ''
            ).trim().toLowerCase();

            const leadPhone = normalizePhone(
                lead.no_wa
            );

            if (!leadName || !leadPhone) {
                return;
            }

            // Cari data berdasarkan Nama + No. WA
            const existingIndex = rows.findIndex(row => {

                const rowName = String(
                    row['Nama'] || ''
                ).trim().toLowerCase();

                const rowPhone = normalizePhone(
                    row['No. WA']
                );

                return (
                    rowName === leadName &&
                    rowPhone === leadPhone
                );
            });

            // ==========================================
            // DATA SUDAH ADA DI EXCEL
            // ==========================================
            if (existingIndex >= 0) {

                const row = rows[existingIndex];

                // Data utama
                row['Nama'] =
                    lead.nama ||
                    row['Nama'] ||
                    '-';

                row['No. WA'] =
                    lead.no_wa ||
                    row['No. WA'] ||
                    '-';

                row['Email'] = lead.email || row['Email'] || '-';

                row['Tanggal Pernikahan'] =
                    lead.tanggal_pernikahan || row['Tanggal Pernikahan'] || '-';

                // ======================================
                // TANGGAL LAHIR
                // Jangan hapus data yang sudah diisi admin
                // ======================================
                if (
                    lead.tgl_lahir !== undefined &&
                    lead.tgl_lahir !== null &&
                    String(lead.tgl_lahir).trim() !== ''
                ) {
                    row['Tanggal Lahir'] =
                        lead.tgl_lahir;
                }

                if (
                    !row['Tanggal Lahir']
                ) {
                    row['Tanggal Lahir'] = '-';
                }

                // ======================================
                // JENIS KELAMIN
                // Jangan hapus data yang sudah diisi admin
                // ======================================
                if (
                    lead.jenis_kelamin !== undefined &&
                    lead.jenis_kelamin !== null &&
                    String(lead.jenis_kelamin).trim() !== ''
                ) {
                    row['Jenis Kelamin'] =
                        lead.jenis_kelamin;
                }

                if (
                    !row['Jenis Kelamin']
                ) {
                    row['Jenis Kelamin'] = '-';
                }

                // ======================================
                // DOMISILI
                // Jangan hapus data yang sudah diisi admin
                // ======================================
                if (
                    lead.domisili !== undefined &&
                    lead.domisili !== null &&
                    String(lead.domisili).trim() !== ''
                ) {
                    row['Domisili'] =
                        lead.domisili;
                }

                if (
                    !row['Domisili']
                ) {
                    row['Domisili'] = '-';
                }

                if (lead.pekerjaan !== undefined) {
                    row['Pekerjaan'] = lead.pekerjaan || '-';
                }

                if (!row['Pekerjaan']) {
                    row['Pekerjaan'] = '-';
                }

                // ======================================
                // MARKETER
                // ======================================
                        if (lead.customer_service !== undefined) {
                    row['Marketer'] =
                            lead.customer_service || '-';
                }

                // ======================================
                // PROPERTI
                // ======================================
                if (lead.property_name !== undefined) {
                    row['Properti'] =
                        lead.property_name || '-';
                }

                // ======================================
                // STATUS
                // ======================================
                if (lead.status !== undefined) {
                    row['Status'] =
                        lead.status || 'Baru';
                }

                if (!row['Status']) {
                    row['Status'] = 'Baru';
                }

                // ======================================
                // TANGGAL TANYA / BOOKING
                // ======================================
                if (lead.created_at) {
                    row['Tanggal Tanya/Booking'] =
                        lead.created_at;
                }

                if (!row['Tanggal Tanya/Booking']) {
                    row['Tanggal Tanya/Booking'] = '-';
                }

            }

            // ==========================================
            // DATA BELUM ADA DI EXCEL
            // ==========================================
            else {

                rows.push({

                    'Nama':
                        lead.nama || '-',

                    'No. WA':
                        lead.no_wa || '-',

                    'Email':
                        lead.email || '-',

                    'Tanggal Lahir':
                        lead.tgl_lahir || '-',

                    'Tanggal Pernikahan':
                        lead.tanggal_pernikahan || '-',

                    'Jenis Kelamin':
                        lead.jenis_kelamin || '-',

                    'Domisili':
                        lead.domisili || '-',

                    'Pekerjaan':
                        lead.pekerjaan || '-',

                    'Marketer':
                        lead.customer_service || '-',

                    'Properti':
                        lead.property_name || '-',

                    'Status':
                        lead.status || 'Baru',

                    'Tanggal Tanya/Booking':
                        lead.created_at || '-'
                });
            }
        });

        // ==========================================
        // BUAT WORKSHEET BARU
        // ==========================================
        const worksheet =
            XLSX.utils.json_to_sheet(
                rows,
                {
                    header: headers
                }
            );

        // ==========================================
        // BUAT WORKBOOK
        // ==========================================
        const workbook =
            XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(
            workbook,
            worksheet,
            'Customers'
        );

        // ==========================================
        // PASTIKAN FILE EXCEL ADA
        // ==========================================
        if (
            !latestExcelPath
        ) {
            latestExcelPath =
                path.join(
                    DATA_DIR,
                    'customers.xlsx'
                );
        }

        // ==========================================
        // TULIS KE EXCEL
        // ==========================================
        XLSX.writeFile(
            workbook,
            latestExcelPath
        );

        console.log(
    `Excel berhasil disinkronkan: ${leads.length} lead`
);

        console.log(
            `File Excel: ${latestExcelPath}`
        );

        return true;

    } catch (err) {

        console.error(
            'Gagal sinkronisasi Leads ke Excel:',
            err.message
        );

        console.error(err.stack);

        return false;
    }
}
function sanitizeUser(user) {
    if (!user) return null;
    return { id: user.id, username: user.username, role: user.role, name: user.name, slug: user.slug || null, phone: user.phone || null, selected_products: user.selected_products || [] };
}

function sanitizeRichHtml(value) {
    return sanitizeHtml(String(value || ''), {
        allowedTags: [
            'a', 'address', 'article', 'b', 'blockquote', 'br', 'caption', 'code', 'div', 'em',
            'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
            'li', 'ol', 'p', 'pre', 'section', 'small', 'span', 'strong', 'sub', 'sup',
            'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
        ],
        allowedAttributes: {
            '*': ['class', 'id', 'title'],
            a: ['href', 'target', 'rel'],
            img: ['src', 'alt', 'width', 'height', 'loading']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: {
            img: ['http', 'https']
        },
        disallowedTagsMode: 'discard',
        enforceHtmlBoundary: true
    });
}

function sanitizeArticle(article) {
    if (!article) return article;
    return { ...article, isi: sanitizeRichHtml(article.isi) };
}

function escapeEmailHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}

async function sendMarketerAccountNotice(marketer, reason) {
    if (!marketer?.email) {
        console.warn('[Email] Notifikasi marketer dilewati: alamat email kosong.');
        return false;
    }

    if (!mailTransporter || !process.env.SMTP_FROM) {
        console.warn('[Email] SMTP belum dikonfigurasi; notifikasi tidak dikirim.');
        return false;
    }

    const isDeleted = reason === 'deleted';
    const isBlocked = reason === 'blocked';
    const subject = isDeleted
        ? 'Informasi akun marketer AMREI'
        : 'Status keanggotaan marketer AMREI';
    const title = isDeleted
        ? 'Akun marketer AMREI telah dihapus'
        : isBlocked
            ? 'Akun Anda telah diblokir'
            : 'Status keanggotaan Anda sudah tidak aktif';
    const automaticDetail = isDeleted
        ? 'Akun marketer Anda sudah dihapus dari sistem AMREI sehingga Anda tidak dapat menggunakan akun tersebut untuk masuk.'
        : isBlocked
            ? 'Akun Anda telah diblokir oleh Admin AMREI sehingga akses dashboard marketer tidak dapat digunakan. Jika ingin meminta peninjauan atau membuka kembali akun, silakan hubungi Admin AMREI.'
            : 'Status keanggotaan Anda telah dinonaktifkan oleh Admin AMREI sehingga akses dashboard marketer tidak dapat digunakan. Untuk mengajukan pembukaan kembali akun, silakan hubungi Admin AMREI.';
    const detail = String(marketer.keterangan || '').trim() || automaticDetail;
    const emailName = escapeEmailHtml(marketer.name || 'Marketer AMREI');
    const emailTitle = escapeEmailHtml(title);
    const emailDetail = escapeEmailHtml(detail);
    const smtpUser = process.env.SMTP_USER?.trim();
    const from = process.env.SMTP_FROM || smtpUser;

    try {
        await mailTransporter.sendMail({
            from,
            replyTo: smtpUser,
            to: marketer.email,
            subject,
            text: [
                `Halo ${marketer.name || 'Marketer AMREI'},`,
                '',
                title + '.',
                detail,
                '',
                'Silakan hubungi Admin AMREI jika membutuhkan informasi lebih lanjut.',
                '',
                'Salam,',
                'Tim AMREI'
            ].join('\n'),
            html: `
                <p>Halo ${emailName},</p>
                <p><strong>${emailTitle}.</strong></p>
                <p>${emailDetail}</p>
                <p>Silakan hubungi Admin AMREI jika membutuhkan informasi lebih lanjut.</p>
                <p>Salam,<br>Tim AMREI</p>
            `,
            headers: {
                'Auto-Submitted': 'auto-generated',
                'X-Auto-Response-Suppress': 'All'
            }
        });
        console.log(`[Email] Notifikasi marketer dikirim ke ${marketer.email}.`);
        return true;
    } catch (error) {
        console.error(`[Email] Gagal mengirim notifikasi ke ${marketer.email}:`, error.message);
        return false;
    }
}

async function sendMarketerLoginNoticeOnce(marketer) {
    if (!['inactive', 'blocked'].includes(marketer?.status)) return false;

    const claimed = await pool.query(
        `UPDATE users
         SET status_login_notice_sent_for = $1
         WHERE id = $2
           AND status = $1
           AND NOT (status_login_notice_sent_for <=> $1)`,
        [marketer.status, marketer.id]
    );

    if (!claimed.rowCount) return false;
    return sendMarketerAccountNotice(marketer, marketer.status);
}

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.status(401).json({ success: false, message: 'Silakan login terlebih dahulu.' });
}
function isAdmin(req, res, next) {
    if (req.session.user?.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Akses khusus admin.' });
    }

    pool.query(
        `SELECT id, username, name, role FROM users WHERE id = $1 AND role = 'admin'`,
        [req.session.user.id]
    ).then(result => {
        if (!result.rows[0]) {
            return req.session.destroy(() => res.status(403).json({
                success: false,
                message: 'Akun admin tidak lagi tersedia.'
            }));
        }

        req.session.user = sanitizeUser(result.rows[0]);
        next();
    }).catch(error => {
        console.error('[Auth] Gagal memeriksa akun admin:', error.message);
        res.status(500).json({ success: false, message: 'Gagal memeriksa akun admin.' });
    });
}

app.get('/api/admin/dashboard-events', isAdmin, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
    });

    res.write(': connected\n\n');
    adminDashboardClients.add(res);

    req.on('close', () => {
        adminDashboardClients.delete(res);
    });
});

app.get('/api/public/content-events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
    });

    res.write(': connected\n\n');
    publicContentClients.add(res);

    req.on('close', () => {
        publicContentClients.delete(res);
    });
});

function isMarketer(req, res, next) {
    if (req.session.user?.role !== 'marketer') {
        return res.status(403).json({ success: false, message: 'Akses khusus marketer.' });
    }

    pool.query(
        `SELECT id, username, role, status, name, slug, phone, selected_products
         FROM users WHERE username = $1 AND role = 'marketer'`,
        [req.session.user.username]
    ).then(result => {
        const user = result.rows[0];

        if (!user || user.status !== 'active') {
            return req.session.destroy(() => {
                res.status(403).json({
                    success: false,
                    message: 'Akun marketer tidak aktif atau sudah dihapus.'
                });
            });
        }

        req.session.user = sanitizeUser(user);
        next();
    }).catch(error => {
        console.error(error);
        res.status(500).json({ success: false, message: 'Gagal memeriksa akun marketer.' });
    });
}
function redirectForRole(role) { return role === 'admin' ? '/admin-dashboard.html' : '/marketer-dashboard.html'; }

async function ensureAboutContentTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS about_content (
            id INTEGER PRIMARY KEY,
            html TEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

app.get('/api/about', async (_req, res) => {
    try {
        await ensureAboutContentTable();
        const result = await pool.query(
            `SELECT html, updated_at FROM about_content WHERE id = 1`
        );

        res.json({
            success: true,
            html: result.rows[0]?.html ? sanitizeRichHtml(result.rows[0].html) : null,
            updated_at: result.rows[0]?.updated_at || null
        });
    } catch (err) {
        console.error('Gagal mengambil informasi About AMREI:', err);
        res.status(500).json({ success: false, message: 'Gagal mengambil informasi About AMREI.' });
    }
});

app.put('/api/admin/about', isAdmin, async (req, res) => {
    try {
        const html = sanitizeRichHtml(req.body.html).trim();
        if (!html) {
            return res.status(400).json({ success: false, message: 'Isi About AMREI tidak boleh kosong.' });
        }

        await ensureAboutContentTable();
        await pool.query(
            `INSERT INTO about_content (id, html, updated_at)
             VALUES (1, $1, NOW())
             ON DUPLICATE KEY UPDATE html = VALUES(html), updated_at = NOW()`,
            [html]
        );
        const result = await pool.query(`SELECT updated_at FROM about_content WHERE id = 1`);

        res.json({
            success: true,
            message: 'Informasi About AMREI berhasil diperbarui.',
            updated_at: result.rows[0].updated_at
        });
        notifyPublicContentChanged('about');
    } catch (err) {
        console.error('Gagal menyimpan informasi About AMREI:', err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan informasi About AMREI.' });
    }
});

async function ensureActivityTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_information (
            id INTEGER PRIMARY KEY,
            data JSON NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_information_archive (
            id CHAR(36) NOT NULL PRIMARY KEY,
            data JSON NOT NULL,
            archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

app.get('/api/activity', async (_req, res) => {
    try {
        await ensureActivityTables();
        const result = await pool.query(`SELECT data, updated_at FROM activity_information WHERE id = 1`);
        res.json({ success: true, activity: result.rows[0]?.data || null, updated_at: result.rows[0]?.updated_at || null });
    } catch (err) {
        console.error('Gagal mengambil informasi kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal mengambil informasi kegiatan.' });
    }
});

app.get('/api/admin/activity/archive', isAdmin, async (_req, res) => {
    try {
        await ensureActivityTables();
        const result = await pool.query(
            `SELECT id, data, archived_at
             FROM activity_information_archive
             ORDER BY archived_at DESC`
        );
        res.json({ success: true, archives: result.rows });
    } catch (err) {
        console.error('Gagal mengambil arsip kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal mengambil arsip kegiatan.' });
    }
});

app.put('/api/admin/activity', isAdmin, async (req, res) => {
    try {
        const activity = req.body.activity;
        const previousActivity = req.body.previous_activity;
        if (!activity || !String(activity.title || '').trim()) {
            return res.status(400).json({ success: false, message: 'Judul kegiatan wajib diisi.' });
        }

        await ensureActivityTables();
        const client = await pool.connect();
        let result;
        try {
            await client.query('BEGIN');
            const current = await client.query(
                `INSERT INTO activity_information_archive (id, data, archived_at)
                 SELECT UUID(), data, updated_at FROM activity_information WHERE id = 1`
            );
            if (!current.rowCount && previousActivity) {
                await client.query(
                    `INSERT INTO activity_information_archive (id, data, archived_at) VALUES (UUID(), $1, NOW())`,
                    [previousActivity]
                );
            }
            await client.query(
                `INSERT INTO activity_information (id, data, updated_at)
                 VALUES (1, $1, NOW())
                 ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()`,
                [JSON.stringify(activity)]
            );
            result = await client.query(`SELECT updated_at FROM activity_information WHERE id = 1`);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        res.json({ success: true, message: 'Informasi kegiatan berhasil diperbarui.', updated_at: result.rows[0].updated_at });
        notifyPublicContentChanged('activity');
    } catch (err) {
        console.error('Gagal menyimpan informasi kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan informasi kegiatan.' });
    }
});

app.put('/api/admin/activity/archive/:id', isAdmin, async (req, res) => {
    try {
        const activity = req.body.activity;
        if (!activity || !String(activity.title || '').trim()) {
            return res.status(400).json({ success: false, message: 'Judul kegiatan wajib diisi.' });
        }

        await ensureActivityTables();
        const result = await pool.query(
            `UPDATE activity_information_archive
             SET data = $1
             WHERE id = $2
             `,
            [JSON.stringify(activity), req.params.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: 'Arsip kegiatan tidak ditemukan.' });
        }
        res.json({ success: true, message: 'Arsip kegiatan berhasil diperbarui.' });
    } catch (err) {
        console.error('Gagal memperbarui arsip kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal memperbarui arsip kegiatan.' });
    }
});

app.put('/api/admin/activity/archive/:id/restore', isAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const archived = await client.query(
            `SELECT data FROM activity_information_archive WHERE id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!archived.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Arsip kegiatan tidak ditemukan.' });
        }

        await client.query(
            `INSERT INTO activity_information_archive (id, data, archived_at)
             SELECT UUID(), data, updated_at FROM activity_information WHERE id = 1`
        );
        await client.query(
            `INSERT INTO activity_information (id, data, updated_at)
             VALUES (1, $1, NOW())
             ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()`,
            [JSON.stringify(archived.rows[0].data)]
        );
        await client.query(`DELETE FROM activity_information_archive WHERE id = $1`, [req.params.id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Arsip kegiatan berhasil ditampilkan kembali.' });
        notifyPublicContentChanged('activity');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Gagal menampilkan arsip kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal menampilkan arsip kegiatan.' });
    } finally {
        client.release();
    }
});

app.delete('/api/admin/activity/archive/:id', isAdmin, async (req, res) => {
    try {
        await ensureActivityTables();
        const result = await pool.query(
            `DELETE FROM activity_information_archive WHERE id = $1`,
            [req.params.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: 'Arsip kegiatan tidak ditemukan.' });
        }
        res.json({ success: true, message: 'Arsip kegiatan berhasil dihapus.' });
    } catch (err) {
        console.error('Gagal menghapus arsip kegiatan:', err);
        res.status(500).json({ success: false, message: 'Gagal menghapus arsip kegiatan.' });
    }
});

// ---------- Excel helpers ----------
function excelRows(filePath = latestExcelPath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
        const wb = XLSX.readFile(filePath, { cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(ws, { defval: '' });
        } catch (err) {
        console.error('WhatsApp gagal diinisialisasi');
        console.error('ERROR OBJECT:', err);
        console.error('ERROR MESSAGE:', err?.message);
        console.error('ERROR STACK:', err?.stack);

        waClient = null;
        waReady = false;
    } finally {
        waStarting = false;
    }
}

function normalizeHeader(header) {
    const raw = String(header || '').toLowerCase().trim();

    return raw
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(no|nomor|number|telpon|telepon|phone|hp)\b/g, ' ')
        .replace(/\b(wa|whatsapp|chat)\b/g, 'wa')
        .replace(/\b(tgl|tanggal|date|created|dibuat)\b/g, 'tanggal')
        .replace(/\b(nama|name)\b/g, 'nama')
        .replace(/\b(marketer|marketing|sales|salesperson|agent|owner|pic|team|officer|account)\b/g, 'marketer')
        .replace(/\b(customer service|customer-service|customer care|admin|cs)\b/g, 'customer_service')
        .replace(/\b(property|properti|project|cluster|unit|rumah|produk|listing|kavling|casa|type)\b/g, 'property')
        .replace(/\b(alamat|address|domisili|lokasi|location)\b/g, 'domisili')
        .replace(/\b(status|state|stage|incaran)\b/g, 'status')
        .replace(/\b(jenis|type|kategori|tipe)\b/g, 'type')
        .replace(/\s+/g, ' ')
        .trim();
}

function headerTokenSet(value) {
    return new Set(
        normalizeHeader(value)
            .split(' ')
            .map(token => token.trim())
            .filter(Boolean)
    );
}

function firstValue(row, keys, fallback = '') {
    const headers = Object.keys(row);
    const aliasList = Array.isArray(keys) ? keys : [keys];

    for (const alias of aliasList) {
        const normalizedAlias = normalizeHeader(alias);
        const aliasTokens = headerTokenSet(alias);

        let bestHeader = null;
        let bestScore = 0;

        for (const header of headers) {
            const normalizedHeader = normalizeHeader(header);
            const headerTokens = headerTokenSet(header);

            let score = 0;

            if (normalizedHeader === normalizedAlias) {
                score = 1000;
            } else if (normalizedHeader.includes(normalizedAlias)) {
                score = 900 + normalizedAlias.length;
            } else if (normalizedAlias.includes(normalizedHeader)) {
                score = 800 + normalizedHeader.length;
            } else {
                const commonTokens = [...aliasTokens].filter(token => headerTokens.has(token));
                const tokenOverlap = commonTokens.length;

                if (tokenOverlap > 0) {
                    score = Math.max(score, tokenOverlap * 200 + 1);
                }

                const aliasWords = normalizedAlias.split(' ');
                const headerWords = normalizedHeader.split(' ');

                const nearMatch = aliasWords.some(word =>
                    word.length > 2 && headerWords.some(headerWord =>
                        headerWord === word || headerWord.includes(word) || word.includes(headerWord)
                    )
                );

                if (nearMatch) {
                    score += 50;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestHeader = header;
            }
        }

        if (bestHeader && row[bestHeader] !== undefined && String(row[bestHeader]).trim() !== '') {
            return row[bestHeader];
        }
    }

    return fallback;
}function pickExcelField(row, aliases, fallback = '', orderIndex = -1) {
    const directValue = firstValue(row, aliases, '');

    if (directValue !== '') {
        return directValue;
    }

    if (orderIndex < 0) {
        return fallback;
    }

    const orderedValues = Object.values(row)
        .map(value => String(value ?? '').trim())
        .filter(value => value !== '');

    if (orderedValues[orderIndex] !== undefined) {
        return orderedValues[orderIndex];
    }

    return fallback;
}

const COLUMN_MAP = {

    nama: [
        'nama',
        'name',
        'full name',
        'fullname',
        'nama lengkap',
        'customer name',
        'nama customer',
        'nama konsumen'
    ],

    no_wa: [
        'wa',
        'no wa',
        'no. wa',
        'nomor wa',
        'nomor whatsapp',
        'no whatsapp',
        'no. whatsapp',
        'whatsapp',
        'phone',
        'phone number',
        'nomor hp',
        'no hp',
        'handphone',
        'nomor handphone',
        'telepon',
        'no telepon',
        'telephone',
        'nomor telepon'
    ],

    tgl_lahir: [
        'tanggal lahir',
        'tgl lahir',
        'dob',
        'birth date',
        'ultah',
        'tanggal ultah',
        'tanggal ulang tahun'
    ],

    jenis_kelamin: [
        'jenis kelamin',
        'gender',
        'sex',
        'jk',
        'l/p',
        'laki-laki/perempuan'
    ],

    domisili: [
        'domisili',
        'alamat',
        'address'
    ],

    pekerjaan: [
        'pekerjaan',
        'job',
        'occupation',
        'profesi',
        'pekerjaan customer',
        'profesi customer',
        'job title'
    ],

    customer_service: [
        'marketer',
        'marketing',
        'sales',
        'nama marketer',
        'nama marketing',
        'marketing name',
        'nama sales',
        'sales name',
        'salesperson',
        'sales person',
        'nama salesperson',
        'pic',
        'agent',
        'nama agent',
        'nama sales marketing',
        'penjual',
        'owner',
        'nama owner',
        'nama penjual',
        'nama tim',
        'team',
        'nama team',
        'marketing officer',
        'nama marketing officer',
        'marketer name',
        'nama marketer name',
        'nama sales officer',
        'sales officer',
        'customer service',
        'customer-service',
        'cs',
        'nama cs',
        'nama customer service',
        'cs name',
        'nama marketer/cs',
        'nama cs/marketer',
        'nama cs marketing',
        'customer care',
        'nama customer care',
        'admin',
        'nama admin',
        'admin name',
        'sales admin',
        'nama sales admin',
        'marketing admin',
        'nama marketing admin',
        'penanggung jawab customer',
        'nama penanggung jawab',
        'pic customer'
    ],

    property_name: [
        'property',
        'properti',
        'cluster',
        'nama properti',
        'nama cluster',
        'hunian',
        'hunian diminati',
        'cluster diminati',
        'property name',
        'project',
        'nama project',
        'unit',
        'nama unit',
        'property title',
        'nama property',
        'nama rumah',
        'rumah',
        'tipe rumah',
        'produk',
        'nama produk',
        'nama property name',
        'kavling',
        'type property',
        'nama type',
        'listing',
        'property title name',
        'nama listing',
        'nama property title'
    ],

    type: [
        'type',
        'jenis',
        'kategori'
    ],

    status: [
        'status',
        'status incaran',
        'incaran'
    ],

    created_at: [
        'tanggal tanya booking',
        'tanggal tanya',
        'tanggal booking',
        'tgl tanya booking',
        'tgl tanya',
        'tgl booking',
        'booking date',
        'tanya date',
        'created at',
        'created date',
        'tanggal dibuat',
        'date created',
        'tanggal',
        'date'
    ]

};


function excelDateToDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (typeof value === 'number') {
        const d = XLSX.SSF.parse_date_code(value);

        if (d) {
            return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0);
        }

        return null;
    }

    const text = String(value || '').trim();

    if (!text) {
        return null;
    }

    /*
     * Mendukung:
     * 08/14/2026
     * 14/08/2026
     * 08-14-2026
     * 14-08-2026
     */

    const match = text.match(
        /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/
    );

    if (match) {
        const angka1 = Number(match[1]);
        const angka2 = Number(match[2]);
        const tahun = Number(match[3]);

        let bulan;
        let tanggal;

        // Contoh:
        // 14/08/2026 -> DD/MM/YYYY
        if (angka1 > 12) {
            tanggal = angka1;
            bulan = angka2;
        }

        // Contoh:
        // 08/14/2026 -> MM/DD/YYYY
        else if (angka2 > 12) {
            bulan = angka1;
            tanggal = angka2;
        }

        // Kalau keduanya <= 12, kita anggap MM/DD/YYYY
        // karena format file testing AMREI kamu.
        else {
            bulan = angka1;
            tanggal = angka2;
        }

        const result = new Date(
            tahun,
            bulan - 1,
            tanggal
        );

        // Validasi tanggal
        if (
            result.getFullYear() === tahun &&
            result.getMonth() === bulan - 1 &&
            result.getDate() === tanggal
        ) {
            return result;
        }

        return null;
    }

    // Coba format tanggal lain
    const parsed = new Date(text);

    if (!Number.isNaN(parsed.getTime())) {
        return parsed;
    }

    return null;
}

function excelCreatedAtToDate(value) {
    const date = excelDateToDate(value);

    if (!date || date.getFullYear() < 2000) {
        return null;
    }

    return date;
}

function formatDateTimeForStorage(value) {
    const date = excelDateToDate(value);

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        const raw = String(value || '').trim();
        return raw;
    }

    const pad = n => String(n).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toCustomer(row, index) {

    // ==========================================
    // TANGGAL LAHIR
    // ==========================================
    const dobRaw = firstValue(
    row,
    COLUMN_MAP.tgl_lahir,
    ''
);

    const dob = excelDateToDate(dobRaw);

    // ==========================================
    // ID CUSTOMER
    // ==========================================
    let customerId = firstValue(
        row,
        ['ID', 'id'],
        ''
    );

    customerId = String(customerId || '').trim();

    // Kalau ID sudah ada prefix excel-, jangan ditambah lagi
    if (customerId.startsWith('excel-')) {
        customerId = customerId.replace(/^excel-+/, '');
    }

    // Kalau tidak ada ID, gunakan nomor urut
    if (!customerId) {
        customerId = String(index + 1);
    }

    // ==========================================
    // RETURN DATA CUSTOMER
    // ==========================================
    return {

        // ID selalu dalam format angka/string biasa
        // supaya route admin yang menambahkan excel-
        // tidak menghasilkan excel-excel-1
        id: customerId,

        // ==========================================
        // NAMA
        // ==========================================
        nama: String(
            pickExcelField(row, COLUMN_MAP.nama, '-', 0)
        ),

        // ==========================================
        // NO. WHATSAPP
        // ==========================================
        no_wa: String(
            firstValue(row, COLUMN_MAP.no_wa, '')
        ),

        // ==========================================
        // TANGGAL LAHIR
        // ==========================================
        tgl_lahir: dob
            ? `${dob.getFullYear()}-${String(
                dob.getMonth() + 1
            ).padStart(2, '0')}-${String(
                dob.getDate()
            ).padStart(2, '0')}`
            : String(
                pickExcelField(row, COLUMN_MAP.tgl_lahir, '', 2)
            ),

        // ==========================================
        // JENIS KELAMIN
        // ==========================================
        jenis_kelamin: String(
            pickExcelField(row, COLUMN_MAP.jenis_kelamin, '', 3)
        ),

        // ==========================================
        // DOMISILI
        // ==========================================
        domisili: String(
            pickExcelField(row, COLUMN_MAP.domisili, '-', 4)
        ),

        // ==========================================
        // PEKERJAAN
        // ==========================================
        pekerjaan: String(
            firstValue(row, COLUMN_MAP.pekerjaan, '-')
        ),

        // ==========================================
        // MARKETER
        // ==========================================
        customer_service: String(
            firstValue(row, COLUMN_MAP.customer_service, '-')
        ),

        // ==========================================
        // PROPERTI
        // ==========================================
        property_name: String(
            firstValue(row, COLUMN_MAP.property_name, '-')
        ),

        // ==========================================
        // JENIS
        // ==========================================
        type: String(
            firstValue(row, COLUMN_MAP.type, '-')
        ),

        // ==========================================
        // STATUS
        // ==========================================
        status: String(
            pickExcelField(row, COLUMN_MAP.status, '-', 8)
        ),

        // ==========================================
        // TANGGAL TANYA / BOOKING
        // ==========================================
        created_at: formatDateTimeForStorage(
            firstValue(row, [
                'Tanggal Tanya/Booking',
                'Tanggal Tanya',
                'Tanggal Booking',
                'Tgl Tanya/Booking',
                'Tgl Tanya',
                'Tgl Booking',
                'Tanya/Booking',
                'booking date',
                'tanya date',
                'created at',
                'created date',
                'tanggal dibuat',
                ...COLUMN_MAP.created_at
            ], '')
        ),

        // ==========================================
        // SUMBER DATA
        // ==========================================
        source: 'excel'
    };
}

function getExcelCustomers(filePath = latestExcelPath) { return excelRows(filePath).map(toCustomer).filter(c => c.nama !== '-'); }
function birthdayToday(customers) {

    const now = new Date();

    const bulanHariIni = now.getMonth();
    const tanggalHariIni = now.getDate();

    return customers.filter(customer => {

        const tanggalLahir = excelDateToDate(
            customer.tgl_lahir
        );


        if (!tanggalLahir) {
            return false;
        }

        return (
            tanggalLahir.getMonth() === bulanHariIni &&
            tanggalLahir.getDate() === tanggalHariIni
        );
    });
}

function greetingMessage(name = '{{name}}', type = 'birthday') {
    const greeting = type === 'anniversary'
        ? 'Selamat Hari Anniversary'
        : 'Selamat Ulang Tahun';
    const wish = type === 'anniversary'
        ? 'Semoga rumah tangga dan kebersamaan selalu dipenuhi kebahagiaan, keharmonisan, kesehatan, serta keberkahan.'
        : 'Semoga senantiasa diberikan kesehatan, kebahagiaan, umur yang penuh berkah, serta rezeki yang melimpah.';

    return `Untuk *${String(name || '{{name}}').trim()}*

Kami segenap keluarga besar *AMREI Property* mengucapkan:

🎉 ${greeting} 🎉

${wish}

Terima kasih atas kepercayaan yang telah diberikan kepada *AMREI Property*. Jika membutuhkan informasi atau memiliki pertanyaan seputar properti, jangan ragu untuk menghubungi tim kami.

Salam hangat,
*AMREI Property*`;
}

function normalizeWhatsAppMessage(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function greetingSalutationForGender(gender) {
    const normalizedGender = String(gender || '')
        .trim()
        .toLowerCase()
        .replace(/[._]/g, ' ')
        .replace(/\s+/g, ' ');
    if (/^(laki-laki|laki laki|laki|pria|male|man|m)$/.test(normalizedGender)) return 'male';
    if (/^(perempuan|wanita|female|woman|f|p)$/.test(normalizedGender)) return 'female';
    return 'unknown';
}

function applyGreetingSalutation(message, gender) {
    const genderType = greetingSalutationForGender(gender);
    const replacementByGender = {
        male: { bapak: 'bapak', pak: 'pak', ibu: 'bapak', bu: 'pak', kakak: 'bapak', kak: 'pak' },
        female: { bapak: 'ibu', pak: 'bu', ibu: 'ibu', bu: 'bu', kakak: 'ibu', kak: 'bu' },
        unknown: { bapak: 'kakak', pak: 'kak', ibu: 'kakak', bu: 'kak', kakak: 'kakak', kak: 'kak' }
    };
    const replacements = replacementByGender[genderType];

    return String(message || '').replace(/\b(bapak|pak|ibu|bu|kakak|kak)\b/gi, matched => {
        const replacement = replacements[matched.toLowerCase()];
        if (matched === matched.toUpperCase()) return replacement.toUpperCase();
        if (matched[0] === matched[0].toUpperCase()) {
            return replacement.charAt(0).toUpperCase() + replacement.slice(1);
        }
        return replacement;
    });
}

async function getGreetingTargets(customerSource, type) {
    if (customerSource !== 'mysql') {
        return type === 'anniversary'
            ? []
            : birthdayToday(getExcelCustomers());
    }

    const dateColumn = type === 'anniversary'
        ? 'tanggal_pernikahan'
        : 'tgl_lahir';
    const result = await pool.query(`
        SELECT nama, no_wa, jenis_kelamin
        FROM leads
        WHERE ${dateColumn} IS NOT NULL
          AND EXTRACT(DAY FROM ${dateColumn}) = EXTRACT(DAY FROM CURRENT_DATE)
          AND EXTRACT(MONTH FROM ${dateColumn}) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND no_wa IS NOT NULL
          AND TRIM(no_wa) <> ''
        ORDER BY nama ASC
    `);

    return result.rows;
}

// ---------- WhatsApp queue ----------
let waClient = null;
let waReady = false;
let waStarting = false;
const sendQueue = [];
const blastBatches = new Map();
let waQrCode = null;
const processingQueues = new Set();
let waAdminId = null;
let waLoggingOut = false;
let waDisconnecting = false;
let waAuthDir = null;
let waQrTimer = null;
const marketerWhatsAppSessions = new Map();
const WA_QR_TIMEOUT_MS = 60000;
const QUEUE_DELAY_MS = Math.max(60000, Number(process.env.WA_QUEUE_DELAY_MS || 60000));
const MAX_BLAST_BATCH_SIZE = 60;
const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';

function resetWaState() {
    if (waQrTimer) clearTimeout(waQrTimer);
    waQrTimer = null;
    waReady = false;
    waQrCode = null;
    waClient = null;
    waAdminId = null;
}

function scheduleAdminQrExpiry(client, authDir) {
    if (waQrTimer) return;
    waQrTimer = setTimeout(async () => {
        if (waClient !== client || waReady || !waQrCode) return;
        console.log('[WA][ADMIN] QR code kedaluwarsa setelah 1 menit tanpa scan. Klik Hubungkan WhatsApp untuk QR baru.');
        waQrCode = null;
        waDisconnecting = true;
        waClient = null;
        waAdminId = null;
        waAuthDir = null;
        try {
            await cleanupWhatsAppClient(client, authDir, { logout: false, preserveSession: false });
        } catch (error) {
            console.warn('[WA][ADMIN] Cleanup QR kedaluwarsa selesai dengan catatan:', error.message);
        } finally {
            waDisconnecting = false;
            waStarting = false;
            waQrTimer = null;
        }
    }, WA_QR_TIMEOUT_MS);
}

function getWhatsAppSessionDir(sessionName = 'admin-session') {
    const authRoot = path.join(DATA_DIR, '.wwebjs_auth');

    fs.mkdirSync(authRoot, { recursive: true });
    return path.join(authRoot, sessionName);
}

function getMarketerWhatsAppSession(userId) {
    const key = `marketer-${userId}`;
    if (!marketerWhatsAppSessions.has(key)) {
        marketerWhatsAppSessions.set(key, {
            key,
            client: null,
            ready: false,
            starting: false,
            qr: null,
            authDir: getWhatsAppSessionDir(key)
        });
    }
    return marketerWhatsAppSessions.get(key);
}

function formatWaNumber(value) {
    if (!value) return null;
    let n = String(value).replace(/\D/g, '');
    if (n.startsWith('0')) n = '62' + n.slice(1);
    if (n.startsWith('8')) n = '62' + n;
    return n ? `${n}@c.us` : null;
}

async function cleanupWhatsAppClient(client, authDir, options = {}) {
    const activeClient = client === undefined ? waClient : client;
    const targetAuthDir = authDir === undefined ? waAuthDir : authDir;
    const shouldLogout = options.logout === true;
    const preserveSession = options.preserveSession === true;

    if (activeClient) {
        if (shouldLogout) {
            try {
                await Promise.race([
                    Promise.resolve()
                        .then(() => activeClient.logout())
                        .catch(error => {
                            console.warn('[WA] Logout otomatis selesai dengan catatan:', error.message);
                        }),
                    new Promise(resolve => setTimeout(resolve, 10000))
                ]);
            } catch (error) {
                console.warn('[WA] Logout otomatis selesai dengan catatan:', error.message);
            }
        }

        try {
            await Promise.race([
                Promise.resolve()
                    .then(() => activeClient.destroy())
                    .catch(error => {
                        console.warn('[WA] Penutupan client selesai dengan catatan:', error.message);
                    }),
                new Promise(resolve => setTimeout(resolve, 10000))
            ]);
        } catch (error) {
            console.warn('[WA] Penutupan client selesai dengan catatan:', error.message);
        }
    }

    if (targetAuthDir && !preserveSession) {
        try {
            fs.rmSync(targetAuthDir, { recursive: true, force: true });
            console.log('[WA] Folder session lama berhasil dihapus agar QR baru dibuat saat login berikutnya.');
        } catch (error) {
            console.warn('[WA] Folder session lama belum dapat dihapus:', error.message);
        }
    }
}

async function logoutActiveWhatsApp(options = {}) {
    const client = waClient;
    const authDir = waAuthDir;
    const preserveSession = options.preserveSession === true;
    const doLogout = options.logout === true;

    waDisconnecting = true;
    if (waQrTimer) clearTimeout(waQrTimer);
    waQrTimer = null;
    waReady = false;
    waQrCode = null;
    waClient = null;
    waAdminId = null;

    try {
        await cleanupWhatsAppClient(client, authDir, { logout: doLogout, preserveSession });
    } finally {
        waAuthDir = null;
        waDisconnecting = false;
    }

    console.log('[WA] WhatsApp berhasil logout.');
}

async function setActiveWhatsAppNumber(adminId, phone) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE users SET phone = NULL WHERE role = 'admin' AND id <> $1`,
            [adminId]
        );
        await client.query(
            `UPDATE users SET phone = $1 WHERE id = $2 AND role = 'admin'`,
            [phone, adminId]
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
function getChromePath() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    return candidates.find(fs.existsSync) || undefined;
}
async function startWhatsApp(adminId = null) {
    if (!WHATSAPP_ENABLED) return;
    if (waStarting) return;

    console.log('[WA] Memulai proses koneksi WhatsApp...');

    const previousClient = waClient;
    const previousAuthDir = waAuthDir;

    if (previousClient) {
        waStarting = true;
        waDisconnecting = true;
        waReady = false;
        waQrCode = null;
        try {
            await cleanupWhatsAppClient(previousClient, previousAuthDir, { logout: true, preserveSession: false });
        } catch (error) {
            console.warn('[WA] Pembersihan sesi lama gagal:', error.message);
        }
        waClient = null;
        waAdminId = null;
        waAuthDir = null;
        waDisconnecting = false;
    }

    waAdminId = adminId;
    waStarting = true;
    try {
        const chromePath = getChromePath();
        const authDir = getWhatsAppSessionDir();

        const client = new Client({
            authStrategy: new LocalAuth({ dataPath: authDir }),
            puppeteer: {
                headless: true,
                ...(chromePath ? { executablePath: chromePath } : {}),
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--disable-gpu'],
                protocolTimeout: 120000,
                timeout: 120000
            }
        });
        waClient = client;
        waAuthDir = authDir;
        console.log('[WA] Browser WhatsApp sedang dipersiapkan...');
        client.on('qr', async (qr) => {
            waReady = false;
            waQrCode = await qrcode.toDataURL(qr);
            scheduleAdminQrExpiry(client, authDir);
            console.log('\n[WA] Scan QR berikut:');
            console.log('[WA] Silakan scan QR code pada web admin untuk menghubungkan WhatsApp.');
        });
        client.on('ready', async () => {
            if (waQrTimer) clearTimeout(waQrTimer);
            waQrTimer = null;
            waReady = true;
            waQrCode = null;
            const connectedPhone = normalizePhone(client.info?.wid?.user);
            if (waAdminId && connectedPhone) {
                await setActiveWhatsAppNumber(waAdminId, connectedPhone);
                console.log(`[WA] Nomor admin aktif diperbarui: ${connectedPhone}`);
            }
            console.log('[WA] WhatsApp siap.');
            processQueue('admin');
        });
        client.on('disconnected', async reason => {
            if (waDisconnecting) return;
            waDisconnecting = true;
            waReady = false;
            if (waQrTimer) clearTimeout(waQrTimer);
            waQrTimer = null;
            waQrCode = null;
            if (waClient === client) {
                waClient = null;
                waAdminId = null;
            }
            console.log('[WA] Disconnected:', reason);
            try {
                await cleanupWhatsAppClient(client, authDir, { logout: false, preserveSession: false });
            } catch (error) {
                console.warn('[WA] Cleanup setelah disconnect selesai dengan catatan:', error.message);
            } finally {
                if (waClient === null || waClient === client) {
                    waAuthDir = null;
                    waStarting = false;
                }
                waDisconnecting = false;
            }
        });
        await client.initialize();
    } catch (err) {
        console.error('[WA] WhatsApp gagal diinisialisasi:', err.message);
        await cleanupWhatsAppClient(waClient, waAuthDir);
        waClient = null;
        waReady = false;
        waAdminId = null;
        waAuthDir = null;
    } finally {
        if (!waClient && waQrTimer) clearTimeout(waQrTimer);
        if (!waClient) waQrTimer = null;
        waStarting = false;
    }
}

async function startMarketerWhatsApp(userId) {
    if (!WHATSAPP_ENABLED) return;
    const session = getMarketerWhatsAppSession(userId);
    if (session.starting || session.client) return;

    console.log(`[WA][MARKETER:${userId}] Memulai proses koneksi WhatsApp...`);
    session.starting = true;
    try {
        const chromePath = getChromePath();
        const client = new Client({
            authStrategy: new LocalAuth({ dataPath: session.authDir }),
            puppeteer: {
                headless: true,
                ...(chromePath ? { executablePath: chromePath } : {}),
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--disable-gpu'],
                protocolTimeout: 120000,
                timeout: 120000
            }
        });
        session.client = client;
        client.on('qr', async qr => {
            session.ready = false;
            session.qr = await qrcode.toDataURL(qr);
            if (!session.qrTimer) session.qrTimer = setTimeout(async () => {
                if (session.client !== client || session.ready || !session.qr) return;
                console.log(`[WA][MARKETER:${userId}] QR code kedaluwarsa setelah 1 menit tanpa scan. Klik Hubungkan WhatsApp untuk QR baru.`);
                session.qr = null;
                session.client = null;
                session.starting = false;
                try {
                    await cleanupWhatsAppClient(client, session.authDir, { logout: false, preserveSession: false });
                } catch (error) {
                    console.warn(`[WA][MARKETER:${userId}] Cleanup QR kedaluwarsa selesai dengan catatan: ${error.message}`);
                } finally {
                    session.qrTimer = null;
                }
            }, WA_QR_TIMEOUT_MS);
            console.log(`[WA][MARKETER:${userId}] QR code siap, menunggu scan dari HP.`);
        });
        client.on('ready', () => {
            if (session.qrTimer) clearTimeout(session.qrTimer);
            session.qrTimer = null;
            session.ready = true;
            session.qr = null;
            console.log(`[WA][MARKETER:${userId}] WhatsApp berhasil terhubung.`);
            processQueue(session.key);
        });
        client.on('auth_failure', message => {
            console.error(`[WA][MARKETER:${userId}] Autentikasi WhatsApp gagal: ${message}`);
        });
        client.on('disconnected', async reason => {
            session.ready = false;
            if (session.qrTimer) clearTimeout(session.qrTimer);
            session.qrTimer = null;
            session.qr = null;
            session.client = null;
            console.warn(`[WA][MARKETER:${userId}] WhatsApp terputus dari HP/perangkat: ${reason || 'alasan tidak diketahui'}.`);
            try {
                await cleanupWhatsAppClient(client, session.authDir, { logout: false, preserveSession: false });
            } catch (error) {
                console.warn(`[WA][MARKETER:${userId}] Cleanup setelah disconnect selesai dengan catatan: ${error.message}`);
            } finally {
                session.starting = false;
            }
        });
        await client.initialize();
    } catch (error) {
        console.error(`[WA] Marketer ${userId} gagal diinisialisasi:`, error.message);
        await cleanupWhatsAppClient(session.client, session.authDir);
        session.client = null;
        session.ready = false;
        if (session.qrTimer) clearTimeout(session.qrTimer);
        session.qrTimer = null;
        session.qr = null;
    } finally {
        session.starting = false;
    }
}

async function logoutMarketerWhatsApp(userId) {
    const session = getMarketerWhatsAppSession(userId);
    const client = session.client;
    console.log(`[WA][MARKETER:${userId}] Logout WhatsApp diminta dari dashboard.`);
    if (session.qrTimer) clearTimeout(session.qrTimer);
    session.qrTimer = null;
    session.client = null;
    session.ready = false;
    session.qr = null;
    await cleanupWhatsAppClient(client, session.authDir, { logout: true, preserveSession: false });
    marketerWhatsAppSessions.delete(session.key);
    console.log(`[WA][MARKETER:${userId}] WhatsApp berhasil diputuskan dari dashboard.`);
}

async function processQueue(ownerKey = 'admin') {
    if (processingQueues.has(ownerKey)) return;
    if (!WHATSAPP_ENABLED) return;
    const taskIndex = sendQueue.findIndex(item => item.ownerKey === ownerKey && (() => {
        const connection = item.ownerKey?.startsWith('marketer-')
            ? marketerWhatsAppSessions.get(item.ownerKey)
            : { client: waClient, ready: waReady };
        return connection?.ready && connection.client;
    })());
    if (taskIndex < 0) return;
    const task = sendQueue[taskIndex];
    const connection = task.ownerKey?.startsWith('marketer-')
        ? marketerWhatsAppSessions.get(task.ownerKey)
        : { client: waClient, ready: waReady };

    processingQueues.add(ownerKey);
    sendQueue.splice(taskIndex, 1);
    const client = connection.client;

    try {
    if (task.fotos?.length) {
    for (const foto of task.fotos) {
        const fotoUrl = new URL(
            foto,
            'http://localhost:3000'
        ).href;

        const media = await MessageMedia.fromUrl(fotoUrl);

        await client.sendMessage(
            task.noWa,
            media
        );
    }

    await client.sendMessage(
        task.noWa,
        task.message
    );
} else if (task.foto) {
    const fotoUrl = new URL(
        task.foto,
        'http://localhost:3000'
    ).href;

    const media = await MessageMedia.fromUrl(fotoUrl);

    await client.sendMessage(
        task.noWa,
        media,
        {
            caption: task.message
        }
    );
} else {
    await client.sendMessage(
        task.noWa,
        task.message
    );
}
if (task.detailId) {

    await pool.query(
        `
        UPDATE blast_history_detail
        SET status = 'Sent'
        WHERE id = $1
        `,
        [task.detailId]
    );

}

    if (task.batchId) {
        const batch = blastBatches.get(task.batchId);
        if (batch) {
            batch.pending = Math.max(0, batch.pending - 1);
            batch.sent += 1;
        }
    }

    console.log(`[WA][${task.ownerKey === 'admin' ? 'ADMIN' : task.ownerKey.toUpperCase()}] Berhasil terkirim ke ${task.display || task.noWa}`);

} catch (err) {
    if (task.batchId) {
        const batch = blastBatches.get(task.batchId);
        if (batch) {
            batch.pending = Math.max(0, batch.pending - 1);
            batch.failed += 1;
            batch.failures.push({
                nama: task.display || task.noWa,
                noWa: task.noWa,
                error: err.message
            });
        }
    }
    if (task.detailId) {

    await pool.query(
        `
        UPDATE blast_history_detail
        SET status = 'Failed'
        WHERE id = $1
        `,
        [task.detailId]
    );

}
    console.error(
        `[WA][${task.ownerKey === 'admin' ? 'ADMIN' : task.ownerKey.toUpperCase()}] Gagal mengirim ke ${task.display || task.noWa}:`,
        err.message
    );
}

    if (sendQueue.some(item => item.ownerKey === ownerKey)) {
        setTimeout(() => {
            processingQueues.delete(ownerKey);
            processQueue(ownerKey);
        }, QUEUE_DELAY_MS);
    } else {
        processingQueues.delete(ownerKey);
    }
}
function enqueueMessages(items, ownerKey = 'admin') {

    items.forEach(item => {

        const noWa =
            formatWaNumber(item.noWa || item.no_wa);

        if (noWa) {

            sendQueue.push({

                noWa,

                message: item.message,

                foto: item.foto,

                fotos: item.fotos,

                display: item.display || item.noWa,

                batchId: item.batchId,

                detailId: item.detailId,

                ownerKey

            });

        }

    });

    processQueue(ownerKey);

}

// ---------- AI GEMINI ----------
let geminiModel = null;

try {
    if (!process.env.GEMINI_API_KEY) {
        console.log('GEMINI_API_KEY belum ditemukan di .env');
    } else {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        geminiModel = genAI.getGenerativeModel({
            model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
        });

        console.log('Gemini AI berhasil diinisialisasi');
        console.log(`Model Gemini: ${process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'}`);
    }
} catch (err) {
    console.error('Gemini gagal diinisialisasi:', err.message);
}

function fallbackBot(message) {
    const text = String(message).toLowerCase();

    if (text.includes('masuda rukost')) {
        return 'Masuda Rukost Premium berada di Dramaga IPB, Bogor. Properti ini memiliki fasilitas Fully Furnished, AC, Smart Lock, Wi-Fi 100Mbps, dan Kamar Mandi Dalam.';
    }

    if (text.includes('masuda apartkost')) {
        return 'Masuda Apartkost berada di Bogor Utara dengan fasilitas Kolam Renang, Fitness Center, Dapur Bersama, dan Security 24 Jam.';
    }

    if (text.includes('marketer')) {
        return 'Marketer AMREI dapat memilih properti yang ingin dipasarkan dan membagikan link referral kepada calon customer.';
    }

    return 'Maaf, AI sedang tidak dapat merespons. Silakan coba lagi beberapa saat.';
}

// ---------- Auth ----------
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (typeof username !== 'string' || typeof password !== 'string' ||
            username.length < 1 || username.length > 100 ||
            password.length < 1 || password.length > 200) {
            return res.status(400).json({ success: false, message: 'Username atau password tidak valid.' });
        }

        const result = await pool.query(
            `SELECT id, username, password, role, status, name, slug, phone, selected_products, email, keterangan
             FROM users WHERE username = $1`,
            [username.trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        const user = result.rows[0];

        const isBcryptHash = typeof user.password === 'string' && /^\$2[aby]\$/.test(user.password);
        const passwordMatches = isBcryptHash && await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        if (user.role === 'marketer' && user.status !== 'active') {
            await sendMarketerLoginNoticeOnce(user);
            return res.status(403).json({
                success: false,
                message: user.status === 'blocked'
                    ? 'Akun Anda telah diblokir. Cek email Anda untuk informasi selengkapnya.'
                    : 'Status keanggotaan Anda sudah tidak aktif. Cek email Anda untuk informasi selengkapnya.'
            });
        }

        req.session.regenerate(sessionError => {
            if (sessionError) {
                console.error(sessionError);
                return res.status(500).json({ success: false, message: 'Gagal membuat session login.' });
            }
            req.session.user = sanitizeUser(user);
            res.json({ success: true, user: req.session.user, redirectUrl: redirectForRole(user.role) });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal login.' });
    }
});


app.get('/api/marketers', async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                u.name,
                u.phone,
                u.slug,
                u.status,

                COALESCE(
                    (
                        SELECT JSON_ARRAYAGG(p.nama)
                        FROM properties p
                        WHERE JSON_CONTAINS(u.selected_products, JSON_QUOTE(p.id))
                    ),
                    JSON_ARRAY()
                ) AS properties

            FROM users u
            WHERE u.role = 'marketer'
            ORDER BY u.created_at DESC
        `);

        res.json({
            success: true,
            marketers: result.rows
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data marketer.'
        });

    }

});

app.get('/api/admin/marketers', isAdmin, async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                u.id,
                u.name,
                u.username,
                u.email,
                u.phone,
                u.slug,
                u.status,
                u.keterangan,
                u.nik,
                u.nomor_rekening,
                u.foto_marketer,
                u.foto_ktp,
                COALESCE(
                    (
                        SELECT JSON_ARRAYAGG(JSON_OBJECT('id', p.id, 'nama', p.nama))
                        FROM properties p
                        WHERE JSON_CONTAINS(u.selected_products, JSON_QUOTE(p.id))
                    ),
                    JSON_ARRAY()
                ) AS properties
            FROM users u
            WHERE u.role = 'marketer'
            ORDER BY u.created_at DESC
        `);

        res.json({
            success: true,
            data: result.rows
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data marketer.'
        });

    }

});

app.get('/api/admin/marketers/:id/document/:type', isAdmin, async (req, res) => {
    const columnByType = {
        profile: 'foto_marketer',
        ktp: 'foto_ktp'
    };
    const column = columnByType[req.params.type];

    if (!column) {
        return res.status(400).json({ success: false, message: 'Jenis dokumen tidak valid.' });
    }

    try {
        const result = await pool.query(
            `SELECT ${column} AS filename FROM users WHERE id = $1 AND role = 'marketer'`,
            [req.params.id]
        );
        const filename = result.rows[0]?.filename;

        if (!filename) {
            return res.status(404).json({ success: false, message: 'Dokumen tidak ditemukan.' });
        }

        const safeFilename = path.basename(filename);
        const documentPath = path.join(MARKETER_DOCUMENT_DIR, safeFilename);

        try {
            await fs.promises.access(documentPath, fs.constants.R_OK);
        } catch (_error) {
            await pool.query(
                `UPDATE users SET ${column} = NULL WHERE id = $1 AND ${column} = $2`,
                [req.params.id, filename]
            );
            return res.status(404).json({ success: false, message: 'File dokumen marketer sudah tidak tersedia.' });
        }

        res.set('Cache-Control', 'private, no-store');
        return res.sendFile(safeFilename, { root: MARKETER_DOCUMENT_DIR });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: 'Gagal mengambil dokumen marketer.' });
    }
});


app.get('/api/me', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: 'Belum login.' });
    }

    if (req.session.user.role === 'marketer') {
        const result = await pool.query(
            `SELECT id, username, role, status, name, slug, phone, selected_products
             FROM users WHERE username = $1 AND role = 'marketer' AND status = 'active'`,
            [req.session.user.username]
        );

        if (!result.rows[0]) {
            return req.session.destroy(() => res.status(401).json({
                success: false,
                message: 'Akun marketer tidak aktif atau sudah dihapus.'
            }));
        }

        req.session.user = sanitizeUser(result.rows[0]);
    }

    return res.json({ success: true, user: req.session.user });
});
function finishLogout(req, res, response) {
    protectedPageHeaders(res);
    req.session.destroy(error => {
        if (error) {
            console.error('[Auth] Gagal menghancurkan session:', error.message);
            return res.status(500).json({ success: false, message: 'Gagal logout.' });
        }

        res.clearCookie('connect.sid', {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production'
        });
        response();
    });
}

app.post('/api/logout', (req, res) => {
    finishLogout(req, res, () => res.json({ success: true }));
});

// ---------- CHATBOT GEMINI ----------
app.post('/api/chat', isAuthenticated, async (req, res) => {
    try {
        const history = Array.isArray(req.body.history)
            ? req.body.history
            : [];

        // Ambil pesan terakhir dari user
        const lastUserMessage = [...history]
            .reverse()
            .find(item => {
                return item.role === 'user' || item.role === 'human';
            });

        const message =
            lastUserMessage?.parts?.[0]?.text ||
            lastUserMessage?.text ||
            '';

        if (!message.trim()) {
            return res.status(400).json({
                error: 'Pesan kosong.'
            });
        }

        // Jika Gemini tidak tersedia
        if (!geminiModel) {
            return res.json({
                reply: fallbackBot(message)
            });
        }

        /*
         * GEMINI MENGHARUSKAN HISTORY DIMULAI DENGAN USER.
         * Pesan model/greeting yang berada sebelum pesan user dibuang.
         */

        let chatHistory = history
            .map(item => {
                let role = item.role;

                // Sesuaikan role frontend dengan role Gemini
                if (role === 'assistant') {
                    role = 'model';
                }

                if (role === 'human') {
                    role = 'user';
                }

                return {
                    role: role,
                    parts: item.parts || [
                        {
                            text: item.text || ''
                        }
                    ]
                };
            })
            .filter(item => {
                return (
                    (item.role === 'user' || item.role === 'model') &&
                    item.parts?.[0]?.text?.trim()
                );
            });

        // Cari pesan USER pertama
        const firstUserIndex = chatHistory.findIndex(
            item => item.role === 'user'
        );

        // Kalau ada pesan sebelum user pertama, buang
        if (firstUserIndex > 0) {
            chatHistory = chatHistory.slice(firstUserIndex);
        }

        // Pesan terakhir jangan dimasukkan ke history,
        // karena akan dikirim melalui sendMessage()
        if (chatHistory.length > 0) {
            const lastItem = chatHistory[chatHistory.length - 1];

            if (lastItem.role === 'user') {
                chatHistory.pop();
            }
        }

        // Pastikan history tidak diawali model
        if (
            chatHistory.length > 0 &&
            chatHistory[0].role !== 'user'
        ) {
            chatHistory = [];
        }

        const chat = geminiModel.startChat({
            history: chatHistory,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 500
            }
        });


        const propertyResult = await pool.query(`
    SELECT *
    FROM properties
    ORDER BY created_at DESC
`);

const properties = propertyResult.rows;
console.log("Jumlah properti:", properties.length);
console.log(properties);

const propertyData = properties.map((p, index) => `
PROPERTI ${index + 1}
ID: ${p.id}
Nama: ${p.nama}
Tipe: ${p.tipe}
Lokasi: ${p.lokasi}
Harga: ${p.harga}
Komisi: ${p.komisi}
Deskripsi/Fasilitas: ${p.deskripsi}
`).join('\n');

       const prompt = `
Kamu adalah AMREI Bot, asisten AI untuk platform AMREI Property.

TUGAS UTAMA:
Jawab pertanyaan pengguna dengan Bahasa Indonesia yang ramah,
jelas, natural, dan tidak terlalu panjang.

==================================================
INFORMASI TENTANG AMREI
==================================================

AMREI adalah singkatan dari Asosiasi Marketer Real Estate Indonesia.
AMREI merupakan wadah yang berorientasi pada pengembangan dan
penguatan kemampuan marketer di bidang real estate dan properti
di Indonesia.

AMREI berfokus pada pengembangan kompetensi marketer, property
marketing, sales, komunikasi, buyer psychology, follow-up,
negosiasi, digital marketing, networking, dan closing.

Kegiatan AMREI antara lain:
- Webinar
- Kopdar
- Program MarkeThink
- Diskusi dan praktik
- Networking

AMREI juga membahas perkembangan teknologi seperti digital marketing
dan AI dalam pemasaran properti.

Pendekatan AMREI menekankan:
- Pertumbuhan
- Integritas
- Kepercayaan
- Kolaborasi
- Profesionalisme
- Adaptasi terhadap perkembangan teknologi
- Fokus pada kebutuhan konsumen

Filosofi yang menggambarkan pendekatan AMREI:
"Bertumbuh Bersama, Berintegritas dalam Berkarya, dan Membangun
Kepercayaan dalam Industri Real Estate."

RUMUSAN ARAH AMREI:
Mendorong terbentuknya ekosistem marketer real estate Indonesia
yang profesional, kompeten, berintegritas, adaptif terhadap
perkembangan zaman, serta mampu membangun kepercayaan dan
memberikan nilai bagi konsumen dan industri properti.

Salah satu tokoh yang teridentifikasi terkait AMREI adalah
Risky Irawan, S.E., M.M., CPC yang disebut sebagai Ketua Pembina
AMREI dalam sumber yang diberikan.

Abdullah Ramli juga disebut sebagai Sekjen AMREI dan terlibat
sebagai mentor dalam program-program MarkeThink.

CATATAN PENTING:
Informasi di atas merupakan bahan pengetahuan yang diberikan
untuk chatbot. Jangan menyebutnya sebagai dokumen resmi apabila
memang tidak dinyatakan sebagai dokumen resmi.

==================================================
INFORMASI AMREI PROPERTY
==================================================

AMREI Property merupakan platform yang memiliki fitur:
- Properti
- Marketer
- Lead customer
- Inquiry
- Booking
- WhatsApp Blast
- Pengelolaan customer

Marketer dapat memasarkan properti dan mendapatkan lead dari
calon customer.

Customer dapat melakukan inquiry atau booking melalui halaman
properti.

Admin dapat mengelola properti dan lead customer.

==================================================
DATA PROPERTI SAAT INI
==================================================

${propertyData}

==================================================
ATURAN MENJAWAB
==================================================

1. Jika pengguna bertanya "AMREI itu apa?", jawab secara SINGKAT,
   sekitar 1-2 kalimat.

2. Jika pengguna bertanya tentang profil, kegiatan, filosofi,
   nilai, visi, misi, atau tokoh AMREI, gunakan informasi AMREI
   yang tersedia di atas.

3. Jika pengguna bertanya tentang properti, gunakan DATA PROPERTI
   yang tersedia di atas.

4. Jangan mengarang harga, lokasi, fasilitas, komisi, nama tokoh,
   kegiatan, atau informasi AMREI lainnya.

5. Jika informasi tidak tersedia, katakan dengan jujur bahwa
   informasi tersebut belum tersedia.

6. Jika pertanyaan sederhana, jawab sederhana.
   Jangan memberikan penjelasan panjang jika tidak diperlukan.

7. Jika pertanyaan membutuhkan penjelasan, berikan penjelasan
   secukupnya dengan poin-poin jika membantu.

8. Gunakan Bahasa Indonesia yang natural dan mudah dipahami.

9. Jangan pernah meminta pengguna memasukkan GEMINI_API_KEY.

10. Jangan membahas API, kode program, server, atau konfigurasi
    kecuali pengguna memang bertanya tentang hal tersebut.

11. Jangan mengatakan bahwa kamu adalah manusia.

12. Jika pengguna hanya menyapa seperti "halo", "hai", atau
    "selamat pagi", balas dengan ramah dan singkat.

13. Jangan mengulang informasi yang tidak ditanyakan.

14. Untuk pertanyaan di luar informasi AMREI, tetap bantu jawab
    berdasarkan kemampuanmu sebagai AI, tetapi jangan mengklaim
    informasi tersebut berasal dari AMREI.

15. Jika jawaban berisi beberapa saran, langkah, pilihan, atau item
    berlabel, tulis setiap item pada baris terpisah dengan bullet (-).

==================================================
PERTANYAAN PENGGUNA
==================================================

${message}
`;

        const result = await chat.sendMessage(prompt);

        const reply = result.response.text();

        console.log('Gemini:', reply);

        return res.json({
            reply: reply || 'Maaf, saya belum mendapatkan jawaban.'
        });

    } catch (err) {
        console.error('Gemini Chat Error:', err.message);

        return res.status(500).json({
            error: 'Gemini gagal memberikan jawaban.',
            reply: 'Maaf, AI sedang mengalami gangguan. Silakan coba lagi.'
        });
    }
});

// ---------- Properties ----------
app.get('/api/properties', async (req, res) => {
    try {

        const page = parseInt(req.query.page) || 1;
        const limit = 30;
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        // Total data
        const totalResult = await pool.query(
    `
            SELECT COUNT(*) AS total
            FROM properties
            WHERE
                nama ILIKE $1
                OR lokasi ILIKE $1
                OR tipe ILIKE $1
                OR CAST(harga AS TEXT) ILIKE $1
                OR CAST(komisi AS TEXT) ILIKE $1
            `,
            [`%${search}%`]
        );

        const total = Number(totalResult.rows[0].total);

        // Data per halaman
        const result = await pool.query(
    `
            SELECT *
            FROM properties
            WHERE
                nama ILIKE $1
                OR lokasi ILIKE $1
                OR tipe ILIKE $1
                OR CAST(harga AS TEXT) ILIKE $1
                OR CAST(komisi AS TEXT) ILIKE $1
            ORDER BY created_at DESC
            LIMIT $2
            OFFSET $3
            `,
            [
                `%${search}%`,
                limit,
                offset
            ]
        );

        res.json({
            data: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            message: "Gagal mengambil data properti"
        });
    }
});

app.get('/api/properties/all', async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT id, nama
            FROM properties
            ORDER BY created_at DESC
        `);

        res.json(result.rows);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            message: 'Gagal mengambil daftar properti'
        });

    }
});

app.post(
    '/api/properties',
    isAdmin,
    securePropertyUpload,
    async (req, res) => {

        try {
            const {
                nama,
                tipe,
                lokasi,
                harga,
                komisi,
                deskripsi,
                link_sosmed
            } = req.body;
            console.log('LINK SOSMED DITERIMA:', link_sosmed);

            if (!nama) {
                return res.status(400).json({
                    success: false,
                    message: 'Nama properti wajib diisi.'
                });
            }

            const uploadedFiles = getUploadedPropertyFiles(req);
            const imagePaths = getPropertyImagePaths(uploadedFiles);
            const thumbnail = imagePaths[0] || null;

            console.log({
                nama,
                tipe,
                lokasi,
                harga,
                komisi,
                deskripsi,
                link_sosmed,
                thumbnail,
                imagePaths
            });

            await pool.query(
                `INSERT INTO properties
                (id, nama, tipe, lokasi, harga, komisi, deskripsi, thumbnail, images, link_sosmed)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                    randomUUID(),
                    nama,
                    tipe || 'Rukost',
                    lokasi || '-',
                    harga || '-',
                    komisi || '-',
                    deskripsi || '',
                    thumbnail,
                    JSON.stringify(imagePaths),
                    link_sosmed || ''
                ]
            );

            res.json({
                success: true
            });
            notifyPublicContentChanged('properties');

        } catch (err) {

            console.error(
                'Gagal menambahkan properti:',
                err
            );

            res.status(500).json({
                success: false,
                message: 'Gagal menambahkan properti.'
            });
        }
    }
);

app.post('/api/admin/marketers', isAdmin, secureMarketerUpload, async (req, res) => {

    try {

        const body = req.body || {};

        const {
            name,
            email,
            phone,
            username,
            password,
            status,
            keterangan,
            nik,
            nomor_rekening
        } = body;
        const fotoMarketer = getMarketerFile(req, 'foto_marketer');
        const fotoKtp = getMarketerFile(req, 'foto_ktp');
        const deleteFotoMarketer = body.delete_foto_marketer === 'true';
        const deleteFotoKtp = body.delete_foto_ktp === 'true';
        const allowedStatuses = new Set(['active', 'inactive', 'blocked']);

        if (!name || !username || !password || String(password).length < 8) {
            return res.status(400).json({ success: false, message: 'Nama, username, dan password minimal 8 karakter wajib diisi.' });
        }
        if (!allowedStatuses.has(status)) {
            return res.status(400).json({ success: false, message: 'Status marketer tidak valid.' });
        }

        const passwordHash = await bcrypt.hash(String(password), 12);
        const slug = name
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');

        const insertResult = await pool.query(
            `
            INSERT INTO users
            (
                id,
                name,
                email,
                phone,
                username,
                passwordHash,
                role,
                status,
                keterangan,
                nik,
                nomor_rekening,
                foto_marketer,
                foto_ktp,
                slug,
                selected_products
            )
            VALUES
            (
                $1,$2,$3,$4,$5,$6,
                'marketer',
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                JSON_ARRAY()
            )
            RETURNING id
            `,
            [
                randomUUID(),
                name,
                email,
                phone,
                username,
                passwordHash,
                status,
                keterangan,
                nik,
                nomor_rekening,
                fotoMarketer?.filename || null,
                fotoKtp?.filename || null,
                slug
            ]
        );

        const marketerId = insertResult.rows[0].id;
        for (const file of [fotoMarketer, fotoKtp]) {
            if (!file) continue;
            const renamed = `marketer-${marketerId}-${file.fieldname}-${Date.now()}${path.extname(file.filename)}`;
            fs.renameSync(file.path, path.join(MARKETER_DOCUMENT_DIR, renamed));
            await pool.query(
                `UPDATE users SET ${file.fieldname === 'foto_marketer' ? 'foto_marketer' : 'foto_ktp'} = $1 WHERE id = $2`,
                [renamed, marketerId]
            );
        }

        res.json({
            success: true,
            message: 'Marketer berhasil ditambahkan.'
        });
        notifyPublicContentChanged('marketers');

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal menambahkan marketer.'
        });

    }

});


app.put('/api/admin/marketers/:id', isAdmin, secureMarketerUpload, async (req, res) => {

    try {

        const body = req.body || {};

        const { id } = req.params;

        const {
            name,
            email,
            phone,
            username,
            password,
            status,
            keterangan,
            nik,
            nomor_rekening
        } = body;
        const fotoMarketer = getMarketerFile(req, 'foto_marketer');
        const fotoKtp = getMarketerFile(req, 'foto_ktp');
        const deleteFotoMarketer = body.delete_foto_marketer === 'true';
        const deleteFotoKtp = body.delete_foto_ktp === 'true';
        const allowedStatuses = new Set(['active', 'inactive', 'blocked']);

        if (!allowedStatuses.has(status)) {
            return res.status(400).json({ success: false, message: 'Status marketer tidak valid.' });
        }

        const previousResult = await pool.query(
            `SELECT name, email, status, keterangan, foto_marketer, foto_ktp FROM users WHERE id = $1 AND role = 'marketer'`,
            [id]
        );
        const previousMarketer = previousResult.rows[0];

        if (password && password.trim() !== '') {
            if (password.length < 8) {
                return res.status(400).json({ success: false, message: 'Password minimal 8 karakter.' });
            }
            const passwordHash = await bcrypt.hash(password, 12);

            await pool.query(
                `
                UPDATE users
                SET
                    name=$1,
                    email=$2,
                    phone=$3,
                    username=$4,
                    password=$5,
                    status=$6,
                    keterangan=$7,
                    nik=$8,
                    nomor_rekening=$9,
                    foto_marketer=COALESCE($10, foto_marketer),
                    foto_ktp=COALESCE($11, foto_ktp)
                WHERE id=$12
                `,
                [
                    name,
                    email,
                    phone,
                    username,
                    passwordHash,
                    status,
                    keterangan,
                    nik,
                    nomor_rekening,
                    fotoMarketer?.filename || null,
                    fotoKtp?.filename || null,
                    id
                ]
            );

        } else {

            await pool.query(
                `
                UPDATE users
                SET
                    name=$1,
                    email=$2,
                    phone=$3,
                    username=$4,
                    status=$5,
                    keterangan=$6,
                    nik=$7,
                    nomor_rekening=$8,
                    foto_marketer=COALESCE($9, foto_marketer),
                    foto_ktp=COALESCE($10, foto_ktp)
                WHERE id=$11
                `,
                [
                    name,
                    email,
                    phone,
                    username,
                    status,
                    keterangan,
                    nik,
                    nomor_rekening,
                    fotoMarketer?.filename || null,
                    fotoKtp?.filename || null,
                    id
                ]
            );

        }

        for (const [file, oldFilename] of [[fotoMarketer, previousMarketer?.foto_marketer], [fotoKtp, previousMarketer?.foto_ktp]]) {
            if (!file) continue;
            const renamed = `marketer-${id}-${file.fieldname}-${Date.now()}${path.extname(file.filename)}`;
            fs.renameSync(file.path, path.join(MARKETER_DOCUMENT_DIR, renamed));
            await pool.query(
                `UPDATE users SET ${file.fieldname === 'foto_marketer' ? 'foto_marketer' : 'foto_ktp'} = $1 WHERE id = $2`,
                [renamed, id]
            );
            removeMarketerDocument(oldFilename);
        }

        for (const [shouldDelete, file, column, oldFilename] of [
            [deleteFotoMarketer, fotoMarketer, 'foto_marketer', previousMarketer?.foto_marketer],
            [deleteFotoKtp, fotoKtp, 'foto_ktp', previousMarketer?.foto_ktp]
        ]) {
            if (!shouldDelete || file || !oldFilename) continue;
            await pool.query(`UPDATE users SET ${column} = NULL WHERE id = $1`, [id]);
            removeMarketerDocument(oldFilename);
        }

        if (previousMarketer?.status !== status) {
            await pool.query(
                'UPDATE users SET status_login_notice_sent_for = NULL WHERE id = $1',
                [id]
            );
        }

        if (previousMarketer?.status !== status && ['inactive', 'blocked'].includes(status)) {
            await sendMarketerAccountNotice({
                ...previousMarketer,
                name,
                email,
                keterangan
            }, status);
        }

        res.json({
            success: true,
            message: 'Marketer berhasil diperbarui.'
        });
        notifyPublicContentChanged('marketers');

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal memperbarui marketer.'
        });

    }

});

app.delete('/api/admin/marketers/:id', isAdmin, async (req, res) => {

    try {

        const { id } = req.params;

        const marketerResult = await pool.query(
            `SELECT name, email, foto_marketer, foto_ktp FROM users WHERE id = $1 AND role = 'marketer'`,
            [id]
        );
        const marketer = marketerResult.rows[0];

        await pool.query(
            `
            DELETE FROM users
            WHERE id = $1
            AND role = 'marketer'
            `,
            [id]
        );

        if (marketer) {
            await sendMarketerAccountNotice(marketer, 'deleted');
            removeMarketerDocument(marketer.foto_marketer);
            removeMarketerDocument(marketer.foto_ktp);
        }

        res.json({
            success: true,
            message: 'Marketer berhasil dihapus.'
        });
        notifyPublicContentChanged('marketers');

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal menghapus marketer.'
        });

    }

});


app.put(
    '/api/properties/:id',
    isAdmin,
    securePropertyUpload,
    async (req, res) => {

        try {
            const result = await pool.query(
                `SELECT * FROM properties WHERE id = $1`,
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Properti tidak ditemukan.'
                });
            }

            const oldProperty = result.rows[0];
            const existingImages = normalizePropertyImageList(oldProperty.images);
            const oldImagePaths = existingImages.length > 0
                ? existingImages
                : (oldProperty.thumbnail ? [oldProperty.thumbnail] : []);

            const updatedProperty = {
                ...oldProperty,

                nama: req.body.nama ?? oldProperty.nama,
                tipe: req.body.tipe ?? oldProperty.tipe,
                lokasi: req.body.lokasi ?? oldProperty.lokasi,
                harga: req.body.harga ?? oldProperty.harga,
                komisi: req.body.komisi ?? oldProperty.komisi,
                deskripsi: req.body.deskripsi ?? oldProperty.deskripsi,
                link_sosmed: req.body.link_sosmed ?? oldProperty.link_sosmed,
                id: oldProperty.id
            };

            const uploadedFiles = getUploadedPropertyFiles(req);
            const hasRetainedImages = Object.prototype.hasOwnProperty.call(req.body, 'retained_images');
            const retainedImages = hasRetainedImages
                ? normalizePropertyImageList(req.body.retained_images)
                : oldImagePaths;
            const removedImagePaths = oldImagePaths.filter(
                imagePath => !retainedImages.includes(imagePath)
            );

            if (removedImagePaths.length > 0) {
                deletePropertyImageFiles(removedImagePaths);
            }

            if (uploadedFiles.length > 0) {
                const newImagePaths = getPropertyImagePaths(uploadedFiles);
                const updatedImages = [...new Set([...retainedImages, ...newImagePaths])];

                updatedProperty.thumbnail = updatedImages[0] || '';
                updatedProperty.images = updatedImages;

                console.log('Foto baru:', newImagePaths);
                console.log('Foto dipertahankan:', retainedImages);
            } else {
                updatedProperty.thumbnail = retainedImages[0] || '';
                updatedProperty.images = retainedImages;
            }

            await pool.query(
                `UPDATE properties
                 SET nama = $1,
                     tipe = $2,
                     lokasi = $3,
                     harga = $4,
                     komisi = $5,
                     deskripsi = $6,
                     thumbnail = $7,
                     images = $8,
                     link_sosmed = $9
                 WHERE id = $10`,
                [
                    updatedProperty.nama,
                    updatedProperty.tipe,
                    updatedProperty.lokasi,
                    updatedProperty.harga,
                    updatedProperty.komisi,
                    updatedProperty.deskripsi,
                    updatedProperty.thumbnail,
                    JSON.stringify(updatedProperty.images || []),
                    updatedProperty.link_sosmed,
                    updatedProperty.id
                ]
            );

            console.log(
                'Properti berhasil diperbarui:',
                updatedProperty
            );
            notifyPublicContentChanged('properties');

            return res.json({
                success: true,
                message: 'Properti berhasil diperbarui.',
                data: updatedProperty
            });

        } catch (err) {

            console.error(
                'Gagal memperbarui properti:',
                err
            );

            return res.status(500).json({
                success: false,
                message: 'Gagal memperbarui properti.'
            });
        }
    }
);
app.delete('/api/properties/:id', isAdmin, async (req, res) => {
    try {
        console.log("ID yang akan dihapus:", req.params.id);
        const result = await pool.query(
    `SELECT * FROM properties WHERE id = $1`,
    [req.params.id]
);

if (result.rows.length === 0) {
    return res.status(404).json({
        success: false,
        message: 'Properti tidak ditemukan.'
    });
}

const property = result.rows[0];
        const propertyImages = [
            ...(normalizePropertyImageList(property.images) || []),
            ...(property.thumbnail && !normalizePropertyImageList(property.images).includes(property.thumbnail)
                ? [property.thumbnail]
                : [])
        ];

        // ==========================================
        // HAPUS FOTO PROPERTI JIKA ADA
        // ==========================================
        deletePropertyImageFiles(propertyImages);

        await pool.query(
            `DELETE FROM properties WHERE id = $1`,
            [req.params.id]
        );

// ==========================================
// HAPUS PROPERTI DARI PILIHAN SEMUA MARKETER
// ==========================================
        await pool.query(
            `
            UPDATE users
            SET selected_products = JSON_REMOVE(
                selected_products,
                JSON_UNQUOTE(JSON_SEARCH(selected_products, 'one', CAST($1 AS CHAR)))
            )
            WHERE JSON_SEARCH(selected_products, 'one', CAST($1 AS CHAR)) IS NOT NULL
            `,
            [req.params.id]
        );
        console.log(
            'Properti berhasil dihapus:',
            property.nama
        );

        res.json({
            success: true,
            message: 'Properti dan foto berhasil dihapus.'
        });
        notifyPublicContentChanged('properties');

    } catch (err) {

        console.error(
            'Gagal menghapus properti:',
            err
        );

        res.status(500).json({
            success: false,
            message: 'Gagal menghapus properti.'
        });
    }
});

// ---------- Artikel ----------
app.get('/api/artikel', async (req, res) => {

    try {

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        // jumlah artikel
              const totalResult = await pool.query( `
            SELECT COUNT(*) AS total
            FROM articles
            WHERE
                judul ILIKE $1
                OR kategori ILIKE $1
                OR ringkasan ILIKE $1
                OR isi ILIKE $1
            `,
            [`%${search}%`]
            );

        const total = parseInt(totalResult.rows[0].total);

        // data artikel
        const result = await pool.query(`
            SELECT *
            FROM articles
            WHERE
                judul ILIKE $1
                OR kategori ILIKE $1
                OR ringkasan ILIKE $1
                OR isi ILIKE $1
            ORDER BY created_at DESC
            LIMIT $2
            OFFSET $3
            `,
            [
                `%${search}%`,
                limit,
                offset
            ]
        );

        res.json({

            data: result.rows.map(sanitizeArticle),

            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }

        });

    } catch (err) {

        console.error('Gagal mengambil artikel:', err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil artikel.'
        });

    }

});

app.get('/api/artikel/:id', async (req, res) => {

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM articles
            WHERE id = $1
            `,
            [req.params.id]
        );

        if (result.rows.length === 0) {

            return res.status(404).json({
                success: false,
                message: 'Artikel tidak ditemukan.'
            });

        }

        res.json(sanitizeArticle(result.rows[0]));

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil artikel.'
        });

    }

});


app.post(
    '/api/artikel',
    isAdmin,
    secureArticleUpload,
    async (req, res) => {

        try {

            const {
                judul,
                kategori,
                ringkasan,
                isi
            } = req.body;

            const safeIsi = sanitizeRichHtml(isi);
            if (!judul || !safeIsi) {
                return res.status(400).json({
                    success: false,
                    message: 'Judul dan isi wajib diisi.'
                });
            }

            const thumbnail = req.file
                ? `/uploads/artikel/${req.file.filename}`
                : null;

            const result = await pool.query(
                `INSERT INTO articles
                (id, judul, kategori, ringkasan, isi, thumbnail)
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING *`,
                [
                    randomUUID(),
                    judul,
                    kategori || 'Properti',
                    ringkasan || '',
                    safeIsi,
                    thumbnail
                ]
            );

            res.json({
                success: true,
                artikel: result.rows[0]
            });
            notifyPublicContentChanged('articles');

        } catch (err) {

            console.error(
                'Gagal menambahkan artikel:',
                err
            );

            res.status(500).json({
                success: false,
                message: 'Gagal menambahkan artikel.'
            });

        }

    }
);

app.put(
    '/api/artikel/:id',
    isAdmin,
    secureArticleUpload,
    async (req, res) => {

        const result = await pool.query(
    `SELECT * FROM articles WHERE id = $1`,
    [req.params.id]
);

if (result.rows.length === 0) {
    return res.status(404).json({
        success: false,
        message: 'Artikel tidak ditemukan.'
    });
}

const artikel = result.rows[0];

        const {
            judul,
            kategori,
            ringkasan,
            isi
        } = req.body;

        artikel.judul = judul ?? artikel.judul;
        artikel.kategori = kategori ?? artikel.kategori;
        artikel.ringkasan = ringkasan ?? artikel.ringkasan;
        artikel.isi = isi === undefined ? artikel.isi : sanitizeRichHtml(isi);
        if (!artikel.isi.trim()) {
            return res.status(400).json({ success: false, message: 'Isi artikel tidak boleh kosong setelah dibersihkan.' });
        }

        if (req.file) {

            // Hapus thumbnail lama
            if (artikel.thumbnail) {

                const oldThumbnailPath = path.join(
                    ARTICLE_UPLOAD_DIR,
                    path.basename(artikel.thumbnail)
                );

                if (fs.existsSync(oldThumbnailPath)) {
                    fs.unlinkSync(oldThumbnailPath);

                    console.log(
                        'Thumbnail lama berhasil dihapus:',
                        oldThumbnailPath
                    );
                }
            }

            // Simpan thumbnail baru
            artikel.thumbnail = `/uploads/artikel/${req.file.filename}`;
        } 

        await pool.query(
    `UPDATE articles
     SET
        judul = $1,
        kategori = $2,
        ringkasan = $3,
        isi = $4,
        thumbnail = $5
     WHERE id = $6`,
    [
        artikel.judul,
        artikel.kategori,
        artikel.ringkasan,
        artikel.isi,
        artikel.thumbnail,
        artikel.id
    ]
);

        res.json({
            success: true,
            artikel
        });
        notifyPublicContentChanged('articles');

    }
);

app.delete('/api/artikel/:id', isAdmin, async (req, res) => {

    try {

        const result = await pool.query(
            `SELECT * FROM articles WHERE id = $1`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Artikel tidak ditemukan.'
            });
        }

        const artikel = result.rows[0];

        // ==========================================
        // Hapus thumbnail jika ada
        // ==========================================
        if (artikel.thumbnail) {

            const thumbnailPath = path.join(
                ARTICLE_UPLOAD_DIR,
                path.basename(artikel.thumbnail)
            );

            if (fs.existsSync(thumbnailPath)) {

                fs.unlinkSync(thumbnailPath);

                console.log(
                    'Thumbnail artikel dihapus:',
                    thumbnailPath
                );
            }
        }

        // ==========================================
        // Hapus lead dari database.
        // ==========================================
        await pool.query(
            `DELETE FROM articles WHERE id = $1`,
            [req.params.id]
        );

        res.json({
            success: true,
            message: 'Artikel berhasil dihapus.'
        });
        notifyPublicContentChanged('articles');

    } catch (err) {

        console.error(
            'Gagal menghapus artikel:',
            err
        );

        res.status(500).json({
            success: false,
            message: 'Gagal menghapus artikel.'
        });

    }

});


// ---------- Marketer ----------
app.get('/api/marketer/products', isMarketer, async (req, res) => {
    try {

        const userResult = await pool.query(
            `SELECT selected_products
             FROM users
             WHERE username = $1`,
            [req.session.user.username]
        );

        const propertyResult = await pool.query(
            `SELECT *
             FROM properties
             ORDER BY created_at DESC`
        );

        const user = userResult.rows[0];

        res.json({
            all_products: propertyResult.rows,
            selected_products: user?.selected_products || []
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data marketer.'
        });

    }
});


app.post('/api/marketer/products', isMarketer, async (req, res) => {

    try {

        const selected = Array.isArray(req.body.selected_products)
            ? req.body.selected_products.map(String)
            : [];

        const result = await pool.query(
            `UPDATE users
             SET selected_products = $1
             WHERE username = $2
             RETURNING *`,
            [
                JSON.stringify(selected),
                req.session.user.username
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Marketer tidak ditemukan.'
            });
        }

        const user = result.rows[0];

        req.session.user = sanitizeUser(user);
        notifyPublicContentChanged('marketers');

        res.json({
            success: true,
            user: req.session.user
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal menyimpan pilihan properti.'
        });

    }

});


app.get('/api/marketer/leads', isMarketer, async (req, res) => {

    try {

        const marketer = await pool.query(
            `
            SELECT username
            FROM users
            WHERE username = $1
            `,
            [req.session.user.username]
        );

        const marketerUsername = marketer.rows[0].username;

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        // Hitung total data
        const totalResult = await pool.query(
            `
            SELECT COUNT(*) AS total
            FROM leads
            WHERE
                (
                    LOWER(TRIM(customer_service)) = LOWER($1)
                    OR LOWER(TRIM(customer_service)) LIKE LOWER($1) || ' %'
                )
                AND (
                    CONCAT_WS(' ', leads.nama, leads.no_wa, leads.email, leads.tgl_lahir,
                        leads.tanggal_pernikahan, leads.jenis_kelamin, leads.domisili,
                        leads.pekerjaan, leads.customer_service, leads.property_name,
                        leads.jenis_konsumen, leads.status, leads.keterangan) ILIKE $2
                    OR
                    nama ILIKE $2
                    OR no_wa ILIKE $2
                    OR property_name ILIKE $2
                    OR status ILIKE $2
                    OR domisili ILIKE $2
                    OR CAST(created_at AS TEXT) ILIKE $2
                    OR TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI') ILIKE $2
                    OR TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD-FMMM-YYYY') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD/FMMM/YYYY') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD.FMMM.YYYY') ILIKE $2
                    OR LOWER(
                        TO_CHAR(created_at, 'FMDD') || ' ' ||
                        CASE EXTRACT(MONTH FROM created_at)
                            WHEN 1 THEN 'Januari'
                            WHEN 2 THEN 'Februari'
                            WHEN 3 THEN 'Maret'
                            WHEN 4 THEN 'April'
                            WHEN 5 THEN 'Mei'
                            WHEN 6 THEN 'Juni'
                            WHEN 7 THEN 'Juli'
                            WHEN 8 THEN 'Agustus'
                            WHEN 9 THEN 'September'
                            WHEN 10 THEN 'Oktober'
                            WHEN 11 THEN 'November'
                            WHEN 12 THEN 'Desember'
                        END || ' ' || TO_CHAR(created_at, 'YYYY HH24:MI')
                    ) ILIKE LOWER($2)
                )
            `,
            [
                marketerUsername,
                `%${search}%`
            ]
        );

        const total = parseInt(totalResult.rows[0].total);

        // Ambil data sesuai halaman
        const result = await pool.query(
            `
            SELECT *
            FROM leads
            WHERE
                (
                    LOWER(TRIM(customer_service)) = LOWER($1)
                    OR LOWER(TRIM(customer_service)) LIKE LOWER($1) || ' %'
                )
                AND (
                    CONCAT_WS(' ', leads.nama, leads.no_wa, leads.email, leads.tgl_lahir,
                        leads.tanggal_pernikahan, leads.jenis_kelamin, leads.domisili,
                        leads.pekerjaan, leads.customer_service, leads.property_name,
                        leads.jenis_konsumen, leads.status, leads.keterangan) ILIKE $2
                    OR
                    nama ILIKE $2
                    OR no_wa ILIKE $2
                    OR property_name ILIKE $2
                    OR status ILIKE $2
                    OR domisili ILIKE $2
                    OR CAST(created_at AS TEXT) ILIKE $2
                    OR TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI') ILIKE $2
                    OR TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD-FMMM-YYYY') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD/FMMM/YYYY') ILIKE $2
                    OR TO_CHAR(created_at, 'FMDD.FMMM.YYYY') ILIKE $2
                    OR LOWER(
                        TO_CHAR(created_at, 'FMDD') || ' ' ||
                        CASE EXTRACT(MONTH FROM created_at)
                            WHEN 1 THEN 'Januari'
                            WHEN 2 THEN 'Februari'
                            WHEN 3 THEN 'Maret'
                            WHEN 4 THEN 'April'
                            WHEN 5 THEN 'Mei'
                            WHEN 6 THEN 'Juni'
                            WHEN 7 THEN 'Juli'
                            WHEN 8 THEN 'Agustus'
                            WHEN 9 THEN 'September'
                            WHEN 10 THEN 'Oktober'
                            WHEN 11 THEN 'November'
                            WHEN 12 THEN 'Desember'
                        END || ' ' || TO_CHAR(created_at, 'YYYY HH24:MI')
                    ) ILIKE LOWER($2)
                )
            ORDER BY created_at DESC
            LIMIT $3
            OFFSET $4
            `,
            [
                marketerUsername,
                `%${search}%`,
                limit,
                offset
            ]
        );

        res.json({

            data: result.rows,

            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }

        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data lead.'
        });

    }

});

// ---------- WhatsApp message templates ----------
function readMessageTemplateInput(body = {}) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!title || title.length > 120) {
        return { error: 'Judul template wajib diisi dan maksimal 120 karakter.' };
    }

    if (!message) {
        return { error: 'Isi template wajib diisi.' };
    }

    return { title, message };
}

app.get('/api/message-templates', isAuthenticated, async (req, res) => {
    try {
        const values = req.session.user.role === 'admin'
            ? ['admin']
            : ['admin', req.session.user.username];
        const query = req.session.user.role === 'admin'
            ? `SELECT id, title, message, scope, created_by, created_at, updated_at
               FROM message_templates WHERE scope = $1 ORDER BY created_at ASC`
            : `SELECT id, title, message, scope, created_by, created_at, updated_at
               FROM message_templates
               WHERE scope = 'admin' OR (scope = 'marketer' AND created_by = $1)
               ORDER BY scope DESC, created_at ASC`;
        const result = await pool.query(query, req.session.user.role === 'admin' ? values : values.slice(1));
        res.json({ success: true, templates: result.rows });
    } catch (error) {
        console.error('[Template] Gagal mengambil template:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil template pesan.' });
    }
});

async function createMessageTemplate(req, res, scope) {
    const input = readMessageTemplateInput(req.body);
    if (input.error) return res.status(400).json({ success: false, message: input.error });

    try {
        const count = scope === 'admin'
            ? await pool.query(`SELECT COUNT(*)::int AS total FROM message_templates WHERE scope = 'admin'`)
            : await pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM message_templates
                 WHERE scope = 'marketer' AND created_by = $1`,
                [req.session.user.username]
            );
        if (count.rows[0].total >= 10) {
            const owner = scope === 'admin' ? 'admin' : 'marketer';
            return res.status(409).json({ success: false, message: `Maksimal 10 template ${owner}. Hapus template lama terlebih dahulu.` });
        }

        const result = await pool.query(
            `INSERT INTO message_templates (id, title, message, scope, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, title, message, scope, created_by, created_at, updated_at`,
            [randomUUID(), input.title, input.message, scope, req.session.user.username]
        );
        res.status(201).json({ success: true, template: result.rows[0] });
    } catch (error) {
        console.error('[Template] Gagal membuat template:', error);
        res.status(500).json({ success: false, message: 'Gagal membuat template pesan.' });
    }
}

app.post('/api/admin/message-templates', isAdmin, (req, res) => createMessageTemplate(req, res, 'admin'));
app.post('/api/marketer/message-templates', isMarketer, (req, res) => createMessageTemplate(req, res, 'marketer'));

app.put('/api/marketer/message-templates/:id', isMarketer, async (req, res) => {
    const input = readMessageTemplateInput(req.body);
    if (input.error) return res.status(400).json({ success: false, message: input.error });

    try {
        const result = await pool.query(
            `UPDATE message_templates
             SET title = $1, message = $2, updated_at = NOW()
             WHERE id = $3 AND scope = 'marketer' AND created_by = $4
             RETURNING id, title, message, scope, created_by, created_at, updated_at`,
            [input.title, input.message, req.params.id, req.session.user.username]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Template marketer tidak ditemukan.' });
        }
        res.json({ success: true, template: result.rows[0] });
    } catch (error) {
        console.error('[Template] Gagal memperbarui template marketer:', error);
        res.status(500).json({ success: false, message: 'Gagal memperbarui template pesan.' });
    }
});

app.put('/api/admin/message-templates/:id', isAdmin, async (req, res) => {
    const input = readMessageTemplateInput(req.body);
    if (input.error) return res.status(400).json({ success: false, message: input.error });

    try {
        const result = await pool.query(
            `UPDATE message_templates
             SET title = $1, message = $2, updated_at = NOW()
             WHERE id = $3 AND scope = 'admin'
             RETURNING id, title, message, scope, created_by, created_at, updated_at`,
            [input.title, input.message, req.params.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Template admin tidak ditemukan.' });
        }
        res.json({ success: true, template: result.rows[0] });
    } catch (error) {
        console.error('[Template] Gagal memperbarui template:', error);
        res.status(500).json({ success: false, message: 'Gagal memperbarui template pesan.' });
    }
});

app.delete('/api/message-templates/:id', isAuthenticated, async (req, res) => {
    const scope = req.session.user.role === 'admin' ? 'admin' : 'marketer';
    const conditions = scope === 'admin'
        ? `id = $1 AND scope = 'admin'`
        : `id = $1 AND scope = 'marketer' AND created_by = $2`;
    const values = scope === 'admin'
        ? [req.params.id]
        : [req.params.id, req.session.user.username];

    try {
        const result = await pool.query(`DELETE FROM message_templates WHERE ${conditions} RETURNING id`, values);
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Template tidak ditemukan atau tidak dapat dihapus.' });
        }
        res.json({ success: true, message: 'Template berhasil dihapus.' });
    } catch (error) {
        console.error('[Template] Gagal menghapus template:', error);
        res.status(500).json({ success: false, message: 'Gagal menghapus template pesan.' });
    }
});

// ---------- Public marketer landing + lead ----------
app.get('/m/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'marketer-landing.html')));
app.get('/api/public/marketer/:slug', async (req, res) => {

    try {

        const userResult = await pool.query(
            `SELECT name, slug, phone, selected_products
             FROM users
             WHERE role = 'marketer'
             AND slug = $1`,
            [req.params.slug]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Marketer tidak ditemukan.'
            });
        }

        const user = userResult.rows[0];

        const selectedProducts = user.selected_products || [];

        const propertyResult = await pool.query(
            `SELECT *
             FROM properties
             WHERE JSON_CONTAINS(CAST($1 AS JSON), JSON_QUOTE(id))
             ORDER BY created_at DESC`,
            [JSON.stringify(selectedProducts)]
        );

        res.json({
            marketer: {
                name: user.name,
                slug: user.slug,
                phone: user.phone
            },
            products: propertyResult.rows
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data marketer.'
        });

    }

});



app.post('/api/leads', async (req, res) => {

    const {
    nama,
    no_wa,
    jenis_kelamin,
    tanggal_lahir,
    email,
    tanggal_pernikahan,
    property_id,
    property_name,
    marketer_slug,
    source,
    domisili,
    pekerjaan
} = req.body;
    const weddingDate = String(
        tanggal_pernikahan || req.body.tanggalPernikahan || ''
    ).trim() || null;
    const birthDate = String(
        tanggal_lahir || req.body.tgl_lahir || req.body.tanggalLahir || ''
    ).trim() || null;
    const jenisKonsumen = String(req.body.jenis_konsumen || '').trim() || null;
    let property = null;

    if (!nama || !no_wa || !email || !domisili || (source !== 'general' && !marketer_slug)) return res.status(400).json({ success: false, message: 'Nama, email, nomor WhatsApp, domisili, dan sumber lead wajib diisi.' });

    const marketerResult = source === 'general'
        ? await pool.query(`SELECT id, username, role, phone FROM users WHERE role = 'admin' AND phone IS NOT NULL AND BTRIM(phone) <> '' LIMIT 1`)
        : await pool.query(
            `SELECT id, username, role, phone
             FROM users
             WHERE role = 'marketer'
             AND slug = $1`,
            [marketer_slug]
        );

if (marketerResult.rows.length === 0) {
    return res.status(404).json({
        success: false,
        message: source === 'general'
            ? 'WhatsApp Admin sedang tidak terhubung.'
            : 'Marketer tidak ditemukan.'
    });
}

const marketer = marketerResult.rows[0];
const customerService = source === 'general'
    ? 'Admin'
    : marketer.username;
const recipientPhone = source === 'general'
    ? (marketer.phone || process.env.ADMIN_WHATSAPP)
    : marketer.phone;
if (property_id) {

    const propertyResult = await pool.query(
        `SELECT * FROM properties
         WHERE id = $1`,
        [property_id]
    );

    if (propertyResult.rows.length > 0) {
        property = propertyResult.rows[0];
    }

}
    const result = await pool.query(
`
INSERT INTO leads
(
    id,
    nama,
    no_wa,
    email,
    tanggal_pernikahan,
    customer_service,
    jenis_konsumen,
    pekerjaan,
    tgl_lahir,
    jenis_kelamin,
    domisili,
    property_name,
    status
)
VALUES
($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
RETURNING *;
`,
[
    randomUUID(),
    String(nama).trim(),
    String(no_wa).trim(),
    String(email).trim(),
    weddingDate,
    customerService,
    jenisKonsumen,
    pekerjaan ? String(pekerjaan).trim() : null,
    birthDate,
    jenis_kelamin ? String(jenis_kelamin).trim() : null,
    domisili ? String(domisili).trim() : null,
    property?.nama || property_name || null,
    'Baru'
]);

const lead = result.rows[0];

// Sinkronkan lead baru ke Excel
await writeLeadsToExcel();
    notifyAdminDashboard('lead-created', { leadId: lead.id });
    notifyPublicContentChanged('lead-created');
    res.json({ success: true, message: 'Data berhasil dikirim ke AMREI.', data: lead, whatsapp: formatWaNumber(recipientPhone) });
});

app.put('/api/marketer/leads/:id', isMarketer, async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE leads
            SET nama = $1, no_wa = $2, tgl_lahir = NULLIF($3, '')::date,
                jenis_kelamin = NULLIF($4, ''), email = NULLIF($5, ''),
                tanggal_pernikahan = NULLIF($6, '')::date, pekerjaan = NULLIF($7, ''),
                jenis_konsumen = NULLIF($8, ''), domisili = NULLIF($9, ''),
                property_name = NULLIF($10, ''), status = NULLIF($11, ''),
                keterangan = NULLIF($12, '')
            WHERE id = $13
              AND (LOWER(TRIM(customer_service)) = LOWER($14)
                   OR LOWER(TRIM(customer_service)) LIKE LOWER($14) || ' %')
            RETURNING *
        `, [
            req.body.nama || '', req.body.no_wa || '', req.body.tgl_lahir || '', req.body.jenis_kelamin || '',
            req.body.email || '', req.body.tanggal_pernikahan || '', req.body.pekerjaan || '', req.body.jenis_konsumen || '',
            req.body.domisili || '', req.body.property_name || '', req.body.status || '', req.body.keterangan || '',
            req.params.id, req.session.user.username
        ]);

        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Lead tidak ditemukan.' });
        await writeLeadsToExcel();
        notifyAdminDashboard('lead-updated', { leadId: result.rows[0].id });
        return res.json({ success: true, data: result.rows[0], message: 'Lead berhasil diperbarui.' });
    } catch (err) {
        console.error('Gagal memperbarui lead marketer:', err.message);
        return res.status(500).json({ success: false, message: 'Gagal memperbarui data lead.' });
    }
});

app.delete('/api/marketer/leads/:id', isMarketer, async (req, res) => {
    try {
        const result = await pool.query(`
            DELETE FROM leads
            WHERE id = $1
              AND (LOWER(TRIM(customer_service)) = LOWER($2)
                   OR LOWER(TRIM(customer_service)) LIKE LOWER($2) || ' %')
            RETURNING id
        `, [req.params.id, req.session.user.username]);

        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Lead tidak ditemukan.' });
        await writeLeadsToExcel();
        notifyAdminDashboard('lead-deleted', { leadId: req.params.id });
        return res.json({ success: true, message: 'Lead berhasil dihapus.' });
    } catch (err) {
        console.error('Gagal menghapus lead marketer:', err.message);
        return res.status(500).json({ success: false, message: 'Gagal menghapus lead.' });
    }
});

// ---------- Admin leads ----------
app.get('/api/admin/leads', isAdmin, async (req, res) => {
    try {

        const page = Math.max(
            parseInt(req.query.page) || 1,
            1
            );

            const limit = 50;
            const search = (req.query.search || '').trim();

        // Ambil data lead dari database.
        const result = await pool.query(
                `
                SELECT *
                FROM leads
                WHERE
                    CONCAT_WS(' ', leads.nama, leads.no_wa, leads.email, leads.tgl_lahir,
                        leads.tanggal_pernikahan, leads.jenis_kelamin, leads.domisili,
                        leads.pekerjaan, leads.customer_service, leads.property_name,
                        leads.jenis_konsumen, leads.status, leads.keterangan) ILIKE $1
                    OR
                    nama ILIKE $1
                    OR no_wa ILIKE $1
                    OR customer_service ILIKE $1
                    OR property_name ILIKE $1
                    OR status ILIKE $1
                    OR domisili ILIKE $1
                    OR CAST(tgl_lahir AS TEXT) ILIKE $1
                    OR CAST(created_at AS TEXT) ILIKE $1
                    OR TO_CHAR(tgl_lahir, 'DD-MM-YYYY') ILIKE $1
                    OR TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI') ILIKE $1
                    OR LOWER(
                        TO_CHAR(tgl_lahir, 'DD') || ' ' ||
                        CASE EXTRACT(MONTH FROM tgl_lahir)
                            WHEN 1 THEN 'Januari'
                            WHEN 2 THEN 'Februari'
                            WHEN 3 THEN 'Maret'
                            WHEN 4 THEN 'April'
                            WHEN 5 THEN 'Mei'
                            WHEN 6 THEN 'Juni'
                            WHEN 7 THEN 'Juli'
                            WHEN 8 THEN 'Agustus'
                            WHEN 9 THEN 'September'
                            WHEN 10 THEN 'Oktober'
                            WHEN 11 THEN 'November'
                            WHEN 12 THEN 'Desember'
                        END || ' ' || TO_CHAR(tgl_lahir, 'YYYY')
                    ) ILIKE LOWER($1)
                    OR LOWER(
                        TO_CHAR(created_at, 'DD') || ' ' ||
                        CASE EXTRACT(MONTH FROM created_at)
                            WHEN 1 THEN 'Januari'
                            WHEN 2 THEN 'Februari'
                            WHEN 3 THEN 'Maret'
                            WHEN 4 THEN 'April'
                            WHEN 5 THEN 'Mei'
                            WHEN 6 THEN 'Juni'
                            WHEN 7 THEN 'Juli'
                            WHEN 8 THEN 'Agustus'
                            WHEN 9 THEN 'September'
                            WHEN 10 THEN 'Oktober'
                            WHEN 11 THEN 'November'
                            WHEN 12 THEN 'Desember'
                        END || ' ' || TO_CHAR(created_at, 'YYYY HH24:MI')
                    ) ILIKE LOWER($1)
                ORDER BY created_at DESC
                `,
                [`%${search}%`]
            );

        const combined = [...result.rows];

const total = combined.length;

const totalPages = Math.ceil(total / limit);

const startIndex = (page - 1) * limit;

const endIndex = startIndex + limit;

const paginatedLeads = combined.slice(
    startIndex,
    endIndex
);

res.json({
    success: true,
    data: paginatedLeads,
    pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
    }
});

    } catch (err) {

        console.error(
            'Gagal mengambil data Leads:',
            err.message
        );

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data Leads.'
        });
    }
});

app.get(
    '/api/admin/export-leads',
    isAdmin,
    async (_req, res) => {

        try {

            const result = await pool.query(`
                SELECT
                    nama,
                    no_wa,
                    email,
                    tanggal_pernikahan,
                    tgl_lahir,
                    jenis_kelamin,
                    domisili,
                    pekerjaan,
                    customer_service,
                    property_name,
                    status,
                    created_at
                FROM leads
                ORDER BY created_at DESC
            `);

            const workbook =
    XLSX.utils.book_new();

const rows = result.rows.map((lead, index) => ({

    No: index + 1,

    Nama: lead.nama,

    'No WhatsApp': lead.no_wa,

    Email: lead.email,

    'Tanggal Pernikahan': lead.tanggal_pernikahan,

    'Tanggal Lahir': lead.tgl_lahir,

    'Jenis Kelamin': lead.jenis_kelamin,

    Domisili: lead.domisili,

    Pekerjaan: lead.pekerjaan,

    'Customer Service': lead.customer_service,

    Properti: lead.property_name,

    Status: lead.status,

    'Tanggal Lead': lead.created_at

}));

const worksheet =
    XLSX.utils.json_to_sheet(rows);

            XLSX.utils.book_append_sheet(
                workbook,
                worksheet,
                'Lead Customer'
            );

            worksheet['!cols'] = [

    { wch: 6 },   // No

    { wch: 25 },  // Nama

    { wch: 20 },  // No WhatsApp

    { wch: 18 },  // Tanggal Lahir

    { wch: 15 },  // Jenis Kelamin

    { wch: 35 },  // Domisili

    { wch: 22 },  // Marketer

    { wch: 28 },  // Properti

    { wch: 15 },  // Tipe

    { wch: 18 },  // Status

    { wch: 22 }   // Tanggal Lead

];

worksheet['!autofilter'] = {
    ref: worksheet['!ref']
};

worksheet['!freeze'] = {
    xSplit: 0,
    ySplit: 1
};

           const buffer =
    XLSX.write(
        workbook,
        {
            type: 'buffer',
            bookType: 'xlsx'
        }
    );

const today = new Date();

const yyyy = today.getFullYear();

const mm = String(
    today.getMonth() + 1
).padStart(2, '0');

const dd = String(
    today.getDate()
).padStart(2, '0');

const fileName =
    `LeadCustomer_AMREI_${yyyy}-${mm}-${dd}.xlsx`;

res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"`
);

res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
);

res.send(buffer);

        } catch (err) {

            console.error(err);

            res.status(500).json({
                success: false,
                message: 'Gagal export Lead Customer.'
            });

        }

    }
);

app.get('/api/admin/blast-customers', isAdmin, async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT
                MIN(id) AS id,
                nama,
                no_wa,
                GROUP_CONCAT(
                    DISTINCT CASE
                        WHEN property_name IS NOT NULL AND TRIM(property_name) <> ''
                        THEN property_name
                    END
                    ORDER BY property_name
                    SEPARATOR ', '
                ) AS pernah_tertarik
            FROM leads
            WHERE no_wa IS NOT NULL
              AND TRIM(no_wa) <> ''
            GROUP BY nama, no_wa
            ORDER BY nama ASC
        `);

        res.json(result.rows);

    } catch (err) {

        console.error(
            'Gagal mengambil customer blast:',
            err
        );

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil customer blast.'
        });

    }
});

app.get('/api/admin/blast-customers/:propertyName', isAdmin, async (req, res) => {

    try {

        const result = await pool.query(
            `
            SELECT
                id,
                nama,
            } = body;
            FROM leads
            WHERE property_name = $1
            const deleteFotoMarketer = body.delete_foto_marketer === 'true';
            const deleteFotoKtp = body.delete_foto_ktp === 'true';
            ORDER BY nama ASC
            `,
            [req.params.propertyName]
        );

        res.json(result.rows);

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengambil customer.'
        });

    }

});

app.put('/api/admin/leads/:id', isAdmin, async (req, res) => {
    try {
        const leadId = req.params.id;

        const tglLahir =
    req.body.tgl_lahir &&
    req.body.tgl_lahir.trim() !== ''
        ? req.body.tgl_lahir
        : null;

const domisili =
    req.body.domisili?.trim() || null;

const jenis_kelamin =
    req.body.jenis_kelamin?.trim() || null;

const email =
    req.body.email?.trim() || null;

const pekerjaan =
    req.body.pekerjaan?.trim() || null;

const tanggalPernikahan =
    req.body.tanggal_pernikahan?.trim() || null;

const customerService =
    req.body.customer_service?.trim() || req.body.kategori?.trim() || null;

const jenisKonsumen =
    req.body.jenis_konsumen?.trim() || null;

const keterangan =
    req.body.keterangan?.trim() || null;

const result = await pool.query(
    `
    UPDATE leads
    SET
        nama = $1,
        no_wa = $2,
        tgl_lahir = $3,
        jenis_kelamin = $4,
        email = $5,
        tanggal_pernikahan = $6,
        pekerjaan = $7,
        customer_service = $8,
        jenis_konsumen = $9,
        domisili = $10,
        property_name = $11,
        status = $12,
        keterangan = $13
    WHERE id = $14
    RETURNING *;
    `,
    [
    req.body.nama,
    req.body.no_wa,
    tglLahir,
    jenis_kelamin,
    email,
    tanggalPernikahan,
    pekerjaan,
    customerService,
    jenisKonsumen,
    domisili,
    req.body.property_name,
    req.body.status,
    keterangan,
    leadId
]
);

if (result.rows.length === 0) {
    return res.status(404).json({
        success: false,
        message: 'Lead tidak ditemukan.'
    });
}

return res.json({
    success: true,
    data: result.rows[0],
    message: 'Lead berhasil diperbarui.'
});

    } catch (err) {

        console.error(
            'Gagal memperbarui Lead:',
            err.message
        );

        console.error(err.stack);

        return res.status(500).json({
            success: false,
            message: 'Gagal memperbarui data Lead.'
        });
    }
});



app.delete('/api/admin/leads/:id', isAdmin, async (req, res) => {
    try {

        const leadId = req.params.id;

        const result = await pool.query(
            `
            DELETE FROM leads
            WHERE id = $1
            RETURNING *;
            `,
            [leadId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead tidak ditemukan.'
            });
        }

        console.log(
            'Lead berhasil dihapus:',
            result.rows[0].nama
        );

        return res.json({
            success: true,
            message: 'Lead berhasil dihapus.'
        });

    } catch (err) {

        console.error(
            'Gagal menghapus Lead:',
            err.message
        );

        return res.status(500).json({
            success: false,
            message: 'Gagal menghapus Lead.'
        });

    }
});

// ---------- Excel ----------
app.get('/api/admin/excel-customers', isAdmin, (_req, res) => {
    res.json(getExcelCustomers());
});

app.post(
    '/api/admin/excel-upload',
    isAdmin,
    secureSpreadsheetUpload,
      async (req, res) => {

        try {

            const uploadMode = req.body.upload_mode || 'temporary';
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'File XLSX/XLS tidak ditemukan.'
                });
            }

            latestExcelPath = req.file.path;

            // Baca Excel terbaru
            const customers = getExcelCustomers(
                latestExcelPath
            );

            if (uploadMode === 'temporary') {
                return res.json({
                    success: true,
                    message: `File ${req.file.originalname} berhasil dimuat.`,
                    customers,
                    total_customers: customers.length,
                    imported: false
                });
            }

            let updatedCount = 0;

            for (const customer of customers) {
                const customerPhone = String(customer.no_wa || '').trim();
                const normalizedPhone = normalizePhone(customerPhone);
                const createdAt = excelCreatedAtToDate(customer.created_at) || new Date();

                if (!normalizedPhone) continue;

                const lead = await findExistingLeadByPhone(customerPhone);

                if (lead) {
                    await pool.query(
                        `
                        UPDATE leads
                        SET
                            nama = COALESCE($1, nama),
                            no_wa = COALESCE($2, no_wa),
                            tgl_lahir = COALESCE($3, tgl_lahir),
                            jenis_kelamin = COALESCE($4, jenis_kelamin),
                            domisili = COALESCE($5, domisili),
                            pekerjaan = COALESCE($6, pekerjaan),
                            customer_service = COALESCE($7, customer_service),
                            property_name = COALESCE($8, property_name),
                            status = COALESCE($9, status)
                        WHERE id = $10
                        `,
                        [
                            customer.nama || null,
                            customerPhone || null,
                            customer.tgl_lahir || null,
                            customer.jenis_kelamin || null,
                            customer.domisili || null,
                            customer.pekerjaan || null,
                            customer.customer_service || null,
                            customer.property_name || null,
                            customer.status || null,
                            lead.id
                        ]
                    );
                    updatedCount++;
                } else {
                    await pool.query(
                        `
                        INSERT INTO leads
                        (
                            id,
                            nama,
                            no_wa,
                            tgl_lahir,
                            jenis_kelamin,
                            domisili,
                            pekerjaan,
                            customer_service,
                            property_name,
                            status,
                            created_at
                        )
                        VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                        `,
                        [
                            randomUUID(),
                            customer.nama,
                            customerPhone,
                            customer.tgl_lahir || null,
                            customer.jenis_kelamin || null,
                            customer.domisili || null,
                            customer.pekerjaan || null,
                            customer.customer_service || null,
                            customer.property_name || null,
                            customer.status || 'Baru',
                            createdAt
                        ]
                    );
                    updatedCount++;
                }
            }

            console.log(`\n📊 EXCEL DIPERBARUI`);
            console.log(`📁 File: ${req.file.originalname}`);
            console.log(`📌 Data Excel: ${customers.length}`);
            console.log(`📈 Lead diperbarui: ${updatedCount}`);

            return res.json({
                success: true,
                message: `File ${req.file.originalname} berhasil dimuat.`,
                customers,
                total_customers: customers.length,
                leads_updated: updatedCount
            });

        } catch (err) {

            console.error(
                'Gagal membaca Excel:',
                err
            );

            return res.status(500).json({
                success: false,
                message: 'File Excel gagal diproses.'
            });
        }
    }
);

app.post(
    '/api/admin/excel-preview',
    isAdmin,
    secureSpreadsheetUpload,
    async (req, res) => {

        try {

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'File Excel tidak ditemukan.'
                });
            }

            latestExcelPath = req.file.path;

const customers = getExcelCustomers(
    latestExcelPath
);

            let newData = 0;
            let updateData = 0;

            for (const customer of customers) {

                const customerPhone =
                    String(customer.no_wa || '').trim();

                if (!normalizePhone(customerPhone)) continue;

                const lead = await findExistingLeadByPhone(customerPhone);

                if (lead) {
                    updateData++;
                } else {
                    newData++;
                }

            }

            return res.json({

                success: true,

                total: customers.length,

                newData,

                updateData

            });

        } catch (err) {

            console.error(err);

            return res.status(500).json({
                success: false,
                message: 'Preview gagal dibuat.'
            });

        }

    }
);

app.post(
    '/api/admin/excel-import',
    isAdmin,
    async (req, res) => {

        try {

            if (!latestExcelPath) {
                return res.status(400).json({
                    success: false,
                    message: 'Belum ada file Excel yang dipreview.'
                });
            }

            const customers = getExcelCustomers(
                latestExcelPath
            );

            let insertedCount = 0;
            let updatedCount = 0;

            for (const customer of customers) {

                const tanggalLahir = excelDateToDate(customer.tgl_lahir);
                const createdAt = excelCreatedAtToDate(customer.created_at) || new Date();

                const customerPhone =
                    String(customer.no_wa || '').trim();

                if (!normalizePhone(customerPhone)) continue;

                const lead = await findExistingLeadByPhone(customerPhone);

                if (lead) {

                    await pool.query(
                        `
                        UPDATE leads
                        SET
                            nama = COALESCE($1, nama),
                            no_wa = COALESCE($2, no_wa),
                            tgl_lahir = COALESCE($3, tgl_lahir),
                            jenis_kelamin = COALESCE($4, jenis_kelamin),
                            domisili = COALESCE($5, domisili),
                            pekerjaan = COALESCE($6, pekerjaan),
                            customer_service = COALESCE($7, customer_service),
                            property_name = COALESCE($8, property_name),
                            status = COALESCE($9, status)
                        WHERE id = $10
                        `,
                        [
                            customer.nama || null,
                            customerPhone || null,
                            tanggalLahir,
                            customer.jenis_kelamin || null,
                            customer.domisili || null,
                            customer.pekerjaan || null,
                            customer.customer_service || null,
                            customer.property_name || null,
                            customer.status || null,
                            lead.id
                        ]
                    );

                    updatedCount++;

                } else {

                    await pool.query(
                        `
                        INSERT INTO leads
                        (
                            id,
                            nama,
                            no_wa,
                            tgl_lahir,
                            jenis_kelamin,
                            domisili,
                            pekerjaan,
                            customer_service,
                            property_name,
                            status,
                            created_at
                        )
                        VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                        `,
                        [
                            randomUUID(),
                            customer.nama,
                            customerPhone,
                            tanggalLahir,
                            customer.jenis_kelamin || null,
                            customer.domisili || null,
                            customer.pekerjaan || null,
                            customer.customer_service || null,
                            customer.property_name || null,
                            customer.status || 'Baru',
                            createdAt
                        ]
                    );

                    insertedCount++;

                }

            }

            latestExcelPath = null;

            return res.json({
                success: true,
                inserted: insertedCount,
                updated: updatedCount,
                message:
                    `Import selesai.\n${insertedCount} data baru.\n${updatedCount} data diperbarui.`
            });

        } catch (err) {

            console.error(err);

            return res.status(500).json({
                success: false,
                message: 'Import Excel gagal.'
            });

        }

    }
);

app.get('/api/admin/birthday-today', isAdmin, (_req, res) => res.json(birthdayToday(getExcelCustomers())));
app.get(
    '/api/admin/birthday-today-mysql',
    isAdmin,
    async (_req, res) => {

        try {

            const result = await pool.query(`
                SELECT
                    nama,
                    no_wa,
                    tgl_lahir
                FROM leads
                WHERE
                    EXTRACT(DAY FROM tgl_lahir)=EXTRACT(DAY FROM CURRENT_DATE)
                AND
                    EXTRACT(MONTH FROM tgl_lahir)=EXTRACT(MONTH FROM CURRENT_DATE)
                ORDER BY nama
            `);

            res.json(result.rows);

        } catch (err) {

            console.error(err);

            res.status(500).json([]);

        }

    }
);

app.get(
    '/api/admin/wedding-anniversary-today',
    isAdmin,
    async (_req, res) => {
        try {
            const result = await pool.query(`
                SELECT nama, no_wa, tanggal_pernikahan
                FROM leads
                WHERE tanggal_pernikahan IS NOT NULL
                  AND EXTRACT(DAY FROM tanggal_pernikahan) = EXTRACT(DAY FROM CURRENT_DATE)
                  AND EXTRACT(MONTH FROM tanggal_pernikahan) = EXTRACT(MONTH FROM CURRENT_DATE)
                ORDER BY nama
            `);

            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json([]);
        }
    }
);

// ---------- WA blast ----------
function waStatus() { return { enabled: WHATSAPP_ENABLED, ready: waReady, queue: sendQueue.filter(item => item.ownerKey === 'admin').length, delay_ms: QUEUE_DELAY_MS }; }

function createBlastBatch(total, ownerKey = 'admin') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    blastBatches.set(id, {
        id,
        total,
        pending: total,
        sent: 0,
        failed: 0,
        failures: [],
        ownerKey,
        createdAt: Date.now()
    });
    return id;
}

function getActiveBlastBatch(ownerKey = 'admin') {
    return [...blastBatches.values()].find(batch => batch.ownerKey === ownerKey && batch.total > 1 && batch.pending > 0);
}

function rejectIfBlastIsBusy(res, ownerKey = 'admin') {
    const activeBatch = getActiveBlastBatch(ownerKey);
    if (!activeBatch) return false;

    res.status(409).json({
        success: false,
        code: 'BULK_BATCH_ACTIVE',
        message: `Blast sebelumnya masih berjalan. Tunggu sampai ${activeBatch.total} pesan selesai terkirim sebelum mengirim batch baru.`,
        batchId: activeBatch.id,
        pending: activeBatch.pending
    });
    return true;
}

app.get('/api/admin/blast-status/:batchId', isAdmin, (req, res) => {
    const batch = blastBatches.get(req.params.batchId);
    if (!batch || batch.ownerKey !== 'admin') {
        return res.status(404).json({ success: false, message: 'Batch pengiriman tidak ditemukan.' });
    }

    res.json({
        success: true,
        ...batch,
        done: batch.pending === 0
    });
});

app.get('/api/admin/greeting-preview', isAdmin, async (req, res) => {
    try {
        const type = req.query.type === 'anniversary' ? 'anniversary' : 'birthday';
        const customerSource = req.query.customerSource === 'excel' ? 'excel' : 'mysql';
        const targets = await getGreetingTargets(customerSource, type);

        res.json({
            type,
            targets,
            template: greetingMessage('{{name}}', type)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal menyiapkan preview ucapan.' });
    }
});
app.get('/api/admin/wa-status', isAdmin, (req, res) => {

    res.json({

        enabled: WHATSAPP_ENABLED,

        ready: waReady,

        queue: sendQueue.filter(item => item.ownerKey === 'admin').length,

        delay_ms: QUEUE_DELAY_MS,

        qr: waQrCode

    });

});

app.post('/api/admin/wa-start', isAdmin, async (req, res) => {

    try {
        console.log(`[WA] Admin ${req.session.user?.id ?? 'unknown'} klik Hubungkan WhatsApp.`);

        if (!waClient && !waStarting) {
            await startWhatsApp(req.session.user?.id);
        }

        return res.json({
            success: true,
            message: 'WhatsApp sedang dihubungkan.'
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: 'Gagal memulai WhatsApp.'
        });

    }

});

app.post('/api/admin/wa-logout', isAdmin, async (req, res) => {

    if (waLoggingOut) {
        return res.json({ success: true, message: 'Logout WhatsApp sedang diproses.' });
    }

    waLoggingOut = true;

    try {
        await logoutActiveWhatsApp({ preserveSession: false, logout: true });
        res.json({ success: true, message: 'WhatsApp berhasil logout.' });
    } catch (err) {
        console.error('[WA] Gagal membersihkan sesi logout:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal membersihkan sesi WhatsApp.'
        });
    } finally {
        waLoggingOut = false;
    }

});

app.get('/api/marketer/wa-status', isMarketer, (req, res) => {
    const session = getMarketerWhatsAppSession(req.session.user.id);
    res.json({
        enabled: WHATSAPP_ENABLED,
        ready: session.ready,
        queue: sendQueue.filter(item => item.ownerKey === session.key).length,
        delay_ms: QUEUE_DELAY_MS,
        qr: session.qr
    });
});

app.post('/api/marketer/wa-start', isMarketer, async (req, res) => {
    try {
        await startMarketerWhatsApp(req.session.user.id);
        res.json({ success: true, message: 'WhatsApp marketer sedang dihubungkan.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memulai WhatsApp marketer.' });
    }
});

app.post('/api/marketer/wa-logout', isMarketer, async (req, res) => {
    try {
        await logoutMarketerWhatsApp(req.session.user.id);
        res.json({ success: true, message: 'WhatsApp marketer berhasil logout.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal logout WhatsApp marketer.' });
    }
});

// app.post('/api/admin/wa-start', isAdmin, async (_req, res) => {
//     if (!WHATSAPP_ENABLED) return res.status(400).json({ success: false, message: 'WHATSAPP_ENABLED=false. Ubah .env menjadi true lalu restart server.' });
//     await startWhatsApp(); res.json({ success: true, status: waStatus() });
// });
app.post('/api/admin/broadcast-ultah', isAdmin, async (req, res) => {

    try {

        if (!waReady || !waClient) {
            return res.status(400).json({
                success: false,
                message: 'Sambungkan WhatsApp terlebih dahulu sebelum mengirim.'
            });
        }

        if (rejectIfBlastIsBusy(res, 'admin')) return;

        const { customerSource, type = 'birthday', messageTemplate } = req.body;

        let targets = [];

        targets = await getGreetingTargets(customerSource, type);

        if (!targets.length) {

            return res.json({
                success: true,
                count: 0,
                message: 'Tidak ada customer yang ulang tahun hari ini.'
            });
        }

        if (targets.length > MAX_BLAST_BATCH_SIZE) {
            return res.status(400).json({
                success: false,
                message: `Maksimal ${MAX_BLAST_BATCH_SIZE} pesan dalam satu kali kirim. Saat ini ada ${targets.length} target.`
            });
        }

        const batchId = createBlastBatch(targets.length, 'admin');

        enqueueMessages(

            targets.map(c => ({

                noWa: c.no_wa,

                display: c.nama,

                message: normalizeWhatsAppMessage(
                    applyGreetingSalutation(
                        String(messageTemplate || greetingMessage('{{name}}', type))
                            .replace(/\{\{\s*(name|nama_customer)\s*\}\}/gi, String(c.nama || '').trim()),
                        c.jenis_kelamin
                    )
                ),
                batchId

            }))

        );

        res.json({

            success: true,

            count: targets.length,
            batchId,

            message:
`${targets.length} ucapan ${type === 'anniversary' ? 'anniversary' : 'ulang tahun'} masuk antrean dengan jeda ${QUEUE_DELAY_MS / 60000} menit/pesan.`,

            status: waStatus()

        });

    } catch (err) {

        console.error(err);

        res.status(500).json({

            success: false,

            message: 'Gagal mengirim ucapan ulang tahun.'

        });

    }

});
app.get('/api/admin/product-preview/:propertyId', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, nama, lokasi, harga, deskripsi, thumbnail, images, link_sosmed FROM properties WHERE id = $1',
            [req.params.propertyId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Properti tidak ditemukan.' });
        }

        const property = result.rows[0];
        let images = [];
        try {
            images = Array.isArray(property.images)
                ? property.images
                : JSON.parse(property.images || '[]');
        } catch (_error) {
            images = [];
        }

        res.json({
            ...property,
            images: [...new Set([...(images || []), property.thumbnail].filter(Boolean))]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal menyiapkan preview properti.' });
    }
});

function getPropertySocialLinksText(property) {
    try {
        const rawLinks = typeof property.link_sosmed === 'string'
            ? JSON.parse(property.link_sosmed)
            : property.link_sosmed || {};
        const links = [
            ['Instagram', rawLinks.instagram],
            ['Tiktok', rawLinks.tiktok || rawLinks.tiktok_url],
            ['Facebook', rawLinks.facebook],
            ['Youtube', rawLinks.youtube || rawLinks.youtube_url],
            ['Maps', rawLinks.maps || rawLinks.google_maps || rawLinks.googleMaps]
        ].filter(([, value]) => value && String(value).trim());

        return links.length
            ? links.map(([label, value]) => `• ${label}: ${String(value).trim()}`).join('\n\n')
            : '';
    } catch (_error) {
        return '';
    }
}

function defaultProductBlastMessage(property) {
    const socialLinks = getPropertySocialLinksText(property);
    return `*${property.nama || ''}*\n\n*Lokasi*\n${property.lokasi || '-'}\n\n*Harga*\n${property.harga || '-'}\n\n*Deskripsi*\n${property.deskripsi || '-'}${socialLinks ? `\n\nLihat postingan media sosial properti tersebut:\n\n${socialLinks}` : ''}`;
}

function renderProductBlastTemplate(template, lead, property) {
    const socialLinks = getPropertySocialLinksText(property);
    const replacements = {
        nama_customer: lead?.nama || '',
        name: lead?.nama || '',
        nama_produk: property?.nama || '',
        harga_produk: property?.harga || '-',
        link_produk: socialLinks || '-'
    };

    const renderedMessage = String(template || defaultProductBlastMessage(property)).replace(
        /\{\{\s*(nama_customer|name|nama_produk|harga_produk|link_produk)\s*\}\}/gi,
        (_match, key) => replacements[String(key).toLowerCase()] ?? ''
    );

    return applyGreetingSalutation(renderedMessage, lead?.jenis_kelamin);
}

async function getMarketerBlastLeads(username) {
    const result = await pool.query(
        `SELECT id, nama, no_wa, jenis_kelamin, property_name
         FROM leads
         WHERE no_wa IS NOT NULL
           AND BTRIM(no_wa) <> ''
           AND (LOWER(BTRIM(customer_service)) = LOWER($1)
                OR LOWER(BTRIM(customer_service)) LIKE LOWER($1) || ' %')
         ORDER BY nama ASC`,
        [username]
    );
    return result.rows;
}

async function getMarketerGreetingTargets(username, type) {
    const dateColumn = type === 'anniversary' ? 'tanggal_pernikahan' : 'tgl_lahir';
    const result = await pool.query(
        `SELECT nama, no_wa, jenis_kelamin
         FROM leads
         WHERE ${dateColumn} IS NOT NULL
           AND EXTRACT(DAY FROM ${dateColumn}) = EXTRACT(DAY FROM CURRENT_DATE)
           AND EXTRACT(MONTH FROM ${dateColumn}) = EXTRACT(MONTH FROM CURRENT_DATE)
           AND no_wa IS NOT NULL
           AND BTRIM(no_wa) <> ''
           AND (LOWER(BTRIM(customer_service)) = LOWER($1)
                OR LOWER(BTRIM(customer_service)) LIKE LOWER($1) || ' %')
         ORDER BY nama ASC`,
        [username]
    );
    return result.rows;
}

app.get('/api/marketer/greeting-preview', isMarketer, async (req, res) => {
    try {
        const type = req.query.type === 'anniversary' ? 'anniversary' : 'birthday';
        const targets = await getMarketerGreetingTargets(req.session.user.username, type);
        res.json({ type, targets, template: greetingMessage('{{name}}', type) });
    } catch (error) {
        console.error('[Marketer Blast] Gagal mengambil target ucapan:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil target ucapan marketer.' });
    }
});

app.post('/api/marketer/broadcast-ultah', isMarketer, async (req, res) => {
    try {
        const session = getMarketerWhatsAppSession(req.session.user.id);
        if (!session.ready || !session.client) {
            return res.status(400).json({ success: false, message: 'Sambungkan WhatsApp marketer terlebih dahulu.' });
        }
        const type = req.body.type === 'anniversary' ? 'anniversary' : 'birthday';
        const targets = await getMarketerGreetingTargets(req.session.user.username, type);
        if (!targets.length) return res.json({ success: true, count: 0, message: `Tidak ada customer yang ${type === 'anniversary' ? 'anniversary' : 'ulang tahun'} hari ini.` });
        if (targets.length > MAX_BLAST_BATCH_SIZE) return res.status(400).json({ success: false, message: `Maksimal ${MAX_BLAST_BATCH_SIZE} pesan dalam satu kali kirim.` });
        const batchId = createBlastBatch(targets.length, session.key);
        const template = String(req.body.messageTemplate || greetingMessage('{{name}}', type));
        enqueueMessages(targets.map(customer => ({
            noWa: customer.no_wa,
            display: customer.nama,
            message: normalizeWhatsAppMessage(
                applyGreetingSalutation(
                    template.replace(/\{\{\s*(name|nama_customer)\s*\}\}/gi, customer.nama || ''),
                    customer.jenis_kelamin
                )
            ),
            batchId
        })), session.key);
        console.log(`[WA][MARKETER:${req.session.user.id}] ${targets.length} pesan ${type === 'anniversary' ? 'anniversary' : 'ulang tahun'} masuk antrean.`);
        res.json({ success: true, count: targets.length, batchId, message: `${targets.length} ucapan masuk antrean.` });
    } catch (error) {
        console.error('[Marketer Blast] Gagal mengirim ucapan:', error);
        res.status(500).json({ success: false, message: 'Gagal mengirim ucapan marketer.' });
    }
});

app.get('/api/marketer/blast-customers', isMarketer, async (req, res) => {
    try {
        const leads = await getMarketerBlastLeads(req.session.user.username);
        const customers = new Map();
        leads.forEach(lead => {
            const key = `${lead.nama || ''}|${lead.no_wa}`;
            const current = customers.get(key) || {
                id: lead.id,
                nama: lead.nama,
                no_wa: lead.no_wa,
                pernah_tertarik: []
            };
            if (lead.property_name && !current.pernah_tertarik.includes(lead.property_name)) {
                current.pernah_tertarik.push(lead.property_name);
            }
            customers.set(key, current);
        });
        res.json([...customers.values()].map(customer => ({
            ...customer,
            pernah_tertarik: customer.pernah_tertarik.join(', ')
        })));
    } catch (error) {
        console.error('[Marketer Blast] Gagal mengambil customer:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil customer marketer.' });
    }
});

app.get('/api/marketer/product-preview/:propertyId', isMarketer, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.id, p.nama, p.lokasi, p.harga, p.deskripsi, p.thumbnail, p.images, p.link_sosmed
             FROM properties p
             JOIN users u ON u.username = $1
             WHERE p.id = $2 AND JSON_CONTAINS(u.selected_products, JSON_QUOTE(p.id))`,
            [req.session.user.username, req.params.propertyId]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Properti tidak ditemukan di daftar marketer.' });
        const property = result.rows[0];
        let images = [];
        try { images = Array.isArray(property.images) ? property.images : JSON.parse(property.images || '[]'); } catch (_error) { images = []; }
        res.json({ ...property, images: [...new Set([...(images || []), property.thumbnail].filter(Boolean))] });
    } catch (error) {
        console.error('[Marketer Blast] Gagal menyiapkan properti:', error);
        res.status(500).json({ success: false, message: 'Gagal menyiapkan preview properti.' });
    }
});

app.get('/api/marketer/blast-status/:batchId', isMarketer, (req, res) => {
    const batch = blastBatches.get(req.params.batchId);
    const ownerKey = `marketer-${req.session.user.id}`;
    if (!batch || batch.ownerKey !== ownerKey) return res.status(404).json({ success: false, message: 'Batch pengiriman tidak ditemukan.' });
    res.json({ success: true, ...batch, done: batch.pending === 0 });
});

app.post('/api/admin/broadcast-produk', isAdmin, async (req, res) => {

    try {

        if (!waReady || !waClient) {
            return res.status(400).json({
                success: false,
                message: 'Sambungkan WhatsApp terlebih dahulu sebelum mengirim.'
            });
        }

        if (rejectIfBlastIsBusy(res, 'admin')) return;

        const { targetCustomers, propertyId, message: editedMessage, selectedImages } = req.body;

        const result = await pool.query(
            `SELECT *
             FROM properties
             WHERE id = $1`,
            [propertyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Properti tidak ditemukan.'
            });
        }

        const property = result.rows[0];

        if (!Array.isArray(targetCustomers) || !targetCustomers.length) {
            return res.status(400).json({
                success: false,
                message: 'Pilih customer terlebih dahulu.'
            });
        }

        if (targetCustomers.length > MAX_BLAST_BATCH_SIZE) {
            return res.status(400).json({
                success: false,
                message: `Maksimal ${MAX_BLAST_BATCH_SIZE} pesan dalam satu kali kirim. Saat ini ada ${targetCustomers.length} target.`
            });
        }

        const batchId = createBlastBatch(targetCustomers.length, 'admin');

        let socialLinksText = '-';

    try {
        const rawLinkSosmed = property.link_sosmed;
        const parsed = typeof rawLinkSosmed === 'string' ? JSON.parse(rawLinkSosmed) : rawLinkSosmed || {};
        const links = {
            instagram: parsed?.instagram || '',
            facebook: parsed?.facebook || '',
            tiktok: parsed?.tiktok || '',
            youtube: parsed?.youtube || '',
            maps: parsed?.maps || ''
        };

        const validLinks = [
            { label: 'Instagram', value: links.instagram },
            { label: 'Tiktok', value: links.tiktok },
            { label: 'Facebook', value: links.facebook },
            { label: 'Youtube', value: links.youtube },
            { label: 'Maps', value: links.maps }
        ].filter(item => item.value && String(item.value).trim());

        socialLinksText = validLinks.length
            ? `\n\nLihat postingan media sosial properti tersebut:\n\n${validLinks.map(item => `• ${item.label}: ${String(item.value).trim()}`).join('\n\n')}`
            : '';
    } catch (error) {
        socialLinksText = '';
    }

    const messageTemplate = editedMessage || `*${property.nama.trim()}*

*Lokasi*
${property.lokasi || '-'}

*Harga*
${property.harga || '-'}

*Deskripsi*
${property.deskripsi || ''}${socialLinksText}`;
 


// ===============================
// SIMPAN DETAIL + MASUKKAN KE QUEUE
// ===============================
for (const noWa of targetCustomers) {

    let customerName = null;

    const leadResult = await pool.query(`
        SELECT nama, no_wa, jenis_kelamin
        FROM leads
        WHERE no_wa IS NOT NULL
          AND BTRIM(no_wa) <> ''
    `);
    const matchingLead = leadResult.rows.find(lead => normalizePhone(lead.no_wa) === normalizePhone(noWa));

    if (matchingLead) {
        customerName = matchingLead.nama;
    }

    enqueueMessages([
        {
            noWa,
            display: customerName || noWa,
            message: normalizeWhatsAppMessage(renderProductBlastTemplate(messageTemplate, {
                nama: customerName,
                jenis_kelamin: matchingLead?.jenis_kelamin
            }, property)),
            fotos: Array.isArray(selectedImages) && selectedImages.length
                ? selectedImages
                : (property.thumbnail ? [property.thumbnail] : []),
            batchId
        }
    ]);

}

res.json({
    success: true,
    count: targetCustomers.length,
    batchId,
    message: `${targetCustomers.length} pesan masuk antrean.`,
    status: waStatus()
});

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Gagal mengirim broadcast.'
        });

    }

});

app.post('/api/marketer/broadcast-produk', isMarketer, async (req, res) => {
    try {
        const marketerSession = getMarketerWhatsAppSession(req.session.user.id);
        if (!marketerSession.ready || !marketerSession.client) {
            return res.status(400).json({ success: false, message: 'Sambungkan WhatsApp marketer terlebih dahulu.' });
        }
        if (rejectIfBlastIsBusy(res, marketerSession.key)) return;

        const { targetCustomers, propertyId, message: editedMessage, selectedImages } = req.body;
        if (!Array.isArray(targetCustomers) || !targetCustomers.length) {
            return res.status(400).json({ success: false, message: 'Pilih customer terlebih dahulu.' });
        }
        if (targetCustomers.length > MAX_BLAST_BATCH_SIZE) {
            return res.status(400).json({ success: false, message: `Maksimal ${MAX_BLAST_BATCH_SIZE} pesan dalam satu kali kirim.` });
        }

        const propertyResult = await pool.query(
            `SELECT p.* FROM properties p JOIN users u ON u.username = $1
             WHERE p.id = $2 AND JSON_CONTAINS(u.selected_products, JSON_QUOTE(p.id))`,
            [req.session.user.username, propertyId]
        );
        const property = propertyResult.rows[0];
        if (!property) return res.status(404).json({ success: false, message: 'Properti tidak ditemukan di daftar marketer.' });

        const leads = await getMarketerBlastLeads(req.session.user.username);
        const normalizedTargets = new Set(targetCustomers.map(normalizePhone).filter(Boolean));
        const targets = leads.filter(lead => normalizedTargets.has(normalizePhone(lead.no_wa)));
        if (!targets.length) return res.status(403).json({ success: false, message: 'Customer yang dipilih bukan lead milik Anda.' });

        const batchId = createBlastBatch(targets.length, marketerSession.key);
        const defaultMessage = editedMessage || defaultProductBlastMessage(property);
        const fallbackImages = property.thumbnail ? [property.thumbnail] : [];
        const images = Array.isArray(selectedImages) && selectedImages.length ? selectedImages : fallbackImages;

        enqueueMessages(targets.map(lead => ({
            noWa: lead.no_wa,
            display: lead.nama || lead.no_wa,
            message: normalizeWhatsAppMessage(renderProductBlastTemplate(defaultMessage, lead, property)),
            fotos: images,
            batchId
        })), marketerSession.key);
        console.log(`[WA][MARKETER:${req.session.user.id}] ${targets.length} pesan product blast masuk antrean.`);

        res.json({ success: true, count: targets.length, batchId, message: `${targets.length} pesan masuk antrean.` });
    } catch (error) {
        console.error('[Marketer Blast] Gagal mengirim broadcast:', error);
        res.status(500).json({ success: false, message: 'Gagal mengirim broadcast marketer.' });
    }
});

// Compatibility aliases for old frontend names.
app.get('/api/customers', isAdmin, (_req, res) => res.json(getExcelCustomers()));

// ---------- Pages ----------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

let httpServer;

async function startServer() {
    await pool.waitForDatabase();
    await sessionStore.onReady();
    await Promise.all([
        ensureLeadColumns(),
        ensureUserNoticeColumns(),
        ensureMessageTemplatesTable()
    ]);

    httpServer = app.listen(PORT, () => {
        console.log(`\nAMREI berjalan di http://localhost:${PORT}`);
        // console.log(`Admin: admin / 123`);
        // console.log(`Marketer: adhimas / 123`);
        console.log(`WhatsApp aktif: ${WHATSAPP_ENABLED ? 'YA' : 'TIDAK (ubah .env jika ingin mengaktifkan)'}`);
    });
}

startServer().catch(error => {
    console.error(`❌ Gagal memulai AMREI: ${error.message}`);
    process.exitCode = 1;
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Process] ${signal} diterima, logout WhatsApp sedang diproses...`);

    try {
        if (WHATSAPP_ENABLED) {
            await logoutActiveWhatsApp({ preserveSession: true, logout: false });
            await Promise.all([...marketerWhatsAppSessions.values()].map(session =>
                cleanupWhatsAppClient(session.client, session.authDir, { preserveSession: true })
            ));
        }
    } catch (error) {
        console.error('[Process] Gagal logout WhatsApp saat shutdown:', error.message);
    }

    for (const client of [...adminDashboardClients, ...publicContentClients]) {
        client.end();
    }
    adminDashboardClients.clear();
    publicContentClients.clear();

    await Promise.race([
        new Promise(resolve => httpServer.close(resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    await sessionStore.close();
    await pool.end();
    process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
