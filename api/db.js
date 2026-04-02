const mysql = require('mysql2');
// dotenv is loaded by server.js before this module is required

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 50,
    maxIdle: 10,
    idleTimeout: 300000,          // 5 นาที (เพิ่มจาก 1 นาที)
    queueLimit: 200,
    enableKeepAlive: true,
    keepAliveInitialDelay: 5000,  // keep alive ทุก 5 วินาที
    connectTimeout: 15000,
    charset: 'utf8mb4'
});

// Handle connection errors — auto reconnect
pool.on('error', (err) => {
    console.error('[DB Pool] Connection error:', err.code);
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        console.log('[DB Pool] Connection lost — pool will auto-reconnect on next query');
    }
});

module.exports = pool.promise();
