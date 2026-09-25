const mysql = require('mysql2');

// Remote DB: Data KPI Dashboard (KHD) — ฐานข้อมูลจริงบนเซิร์ฟเวอร์ภายนอกชื่อ schema "hdc" (ดู fallback default ด้านล่าง)
// ตั้งค่าใน .env: KHD_DB_HOST, KHD_DB_PORT, KHD_DB_USER, KHD_DB_PASSWORD, KHD_DB_NAME
let remotePool = null;

const getRemotePool = () => {
    if (!process.env.KHD_DB_HOST) return null;
    if (!remotePool) {
        remotePool = mysql.createPool({
            host: process.env.KHD_DB_HOST,
            user: process.env.KHD_DB_USER,
            password: process.env.KHD_DB_PASSWORD,
            database: process.env.KHD_DB_NAME || 'hdc',
            port: process.env.KHD_DB_PORT || 3306,
            waitForConnections: true,
            connectionLimit: 5,
            connectTimeout: 15000,
            charset: 'utf8mb4'
        });
        console.log(`[Remote DB] Connected to ${process.env.KHD_DB_HOST}:${process.env.KHD_DB_PORT || 3306}/${process.env.KHD_DB_NAME || 'hdc'}`);
    }
    return remotePool.promise();
};

module.exports = { getRemotePool };
