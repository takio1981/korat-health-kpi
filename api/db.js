const mysql = require('mysql2');
// dotenv is loaded by server.js before this module is required

// === Pool configuration ===
// รองรับ 100+ concurrent users:
//   - connectionLimit: 150 (เผื่อ peak load 100+ users + scheduler + admin operations)
//   - queueLimit: 500 (รอคิวได้ยาวกว่า — กัน 503 เมื่อ peak)
//   - ตั้งใน MariaDB: max_connections >= 200 (default 151 ตึงไป)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 150,
    maxIdle: Number(process.env.DB_POOL_MAX_IDLE) || 30,
    idleTimeout: 300000,          // 5 นาที — ปล่อย idle เร็วกว่านี้จะ create connection ใหม่ถี่
    queueLimit: Number(process.env.DB_POOL_QUEUE_LIMIT) || 500,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000, // keep alive ทุก 10 วินาที
    connectTimeout: 20000,        // 20s — เผื่อ DB ภาระสูง
    charset: 'utf8mb4',
    // namedPlaceholders: false  // default — ใช้ ? ปกติ
});

console.log(`[DB Pool] connectionLimit=${pool.config.connectionLimit} queueLimit=${pool.config.queueLimit} maxIdle=${pool.config.maxIdle}`);

// Handle connection errors — auto reconnect
pool.on('error', (err) => {
    console.error('[DB Pool] Connection error:', err.code, err.message);
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        console.log('[DB Pool] Connection lost — pool will auto-reconnect on next query');
    }
});

// Lightweight pool monitor — log สถานะทุก 5 นาที เผื่อ debug
// log เฉพาะเมื่อ pool ใช้งานสูง (> 70%) หรือมีคิวรอ
setInterval(() => {
    try {
        const total = pool._allConnections?.length ?? 0;
        const free = pool._freeConnections?.length ?? 0;
        const queue = pool._connectionQueue?.length ?? 0;
        const used = total - free;
        const usagePct = total > 0 ? (used / pool.config.connectionLimit) * 100 : 0;
        if (usagePct > 70 || queue > 0) {
            console.warn(`[DB Pool] used=${used}/${pool.config.connectionLimit} (${usagePct.toFixed(0)}%) free=${free} queued=${queue}`);
        }
    } catch (e) { /* ignore */ }
}, 60000); // ทุก 1 นาที (เฉพาะเมื่อโหลดสูงเท่านั้นที่ log)

module.exports = pool.promise();
