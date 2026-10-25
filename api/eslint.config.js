// ESLint สำหรับ backend — ตรวจเฉพาะข้อผิดพลาดที่ทำให้ระบบพังตอนรัน (ไม่ใช่เรื่องรูปแบบโค้ด)
// สำคัญตอนแยก server.js เป็นโมดูล: ย้ายฟังก์ชันแล้วลืม require/ส่งออก = ReferenceError เฉพาะตอนเส้นทางนั้นถูกเรียก
// (ชุดทดสอบอาจไม่ครอบคลุม) — `no-undef` จับได้ตั้งแต่ก่อนรัน | รันด้วย `npm run lint` และ tests/lint.test.js
const globals = require('globals');

module.exports = [
    { ignores: ['dist/**', '.build-check/**', 'node_modules/**', 'backups/**', 'coverage/**'] },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-undef': 'error',
            'no-redeclare': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-const-assign': 'error',
            'no-func-assign': 'error',
            'no-import-assign': 'error',
            'no-obj-calls': 'error',
            'no-unreachable': 'warn',
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.jest } },
    },
];
