const mysql = require('mysql2');
// dotenv is loaded by server.js before this module is required

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 50,          // รองรับ 500 users (1 connection : 10 users)
    maxIdle: 20,                  // idle connections ที่เก็บไว้
    idleTimeout: 60000,           // ปิด idle connection หลัง 60 วินาที
    queueLimit: 200,              // queue สูงสุด 200 คำขอ (ป้องกัน memory leak)
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000, // keep alive ทุก 10 วินาที
    connectTimeout: 10000,        // timeout connect 10 วินาที
    charset: 'utf8mb4'
});

module.exports = pool.promise();
