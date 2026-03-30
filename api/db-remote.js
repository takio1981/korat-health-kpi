const mysql = require('mysql2');

// Remote DB: Data KPI Dashboard (hdc)
// ตั้งค่าใน .env: HDC_DB_HOST, HDC_DB_PORT, HDC_DB_USER, HDC_DB_PASSWORD, HDC_DB_NAME
let remotePool = null;

const getRemotePool = () => {
    if (!process.env.HDC_DB_HOST) return null;
    if (!remotePool) {
        remotePool = mysql.createPool({
            host: process.env.HDC_DB_HOST,
            user: process.env.HDC_DB_USER,
            password: process.env.HDC_DB_PASSWORD,
            database: process.env.HDC_DB_NAME || 'hdc',
            port: process.env.HDC_DB_PORT || 3306,
            waitForConnections: true,
            connectionLimit: 5,
            connectTimeout: 15000,
            charset: 'utf8mb4'
        });
        console.log(`[Remote DB] Connected to ${process.env.HDC_DB_HOST}:${process.env.HDC_DB_PORT || 3306}/${process.env.HDC_DB_NAME || 'hdc'}`);
    }
    return remotePool.promise();
};

module.exports = { getRemotePool };
