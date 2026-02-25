const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || '203.157.161.13',
    user: process.env.DB_USER || 'backoffice',
    password: process.env.DB_PASSWORD || 'K@ratHealth!',
    database: process.env.DB_NAME || 'khups_kpi_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 20, // เพิ่ม Limit สำหรับ Production
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

module.exports = pool.promise();
