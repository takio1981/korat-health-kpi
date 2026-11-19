// preload: บล็อกการเชื่อมต่อออกนอกเครื่อง (ฐานทดสอบ/.env.test มีโทเคนและบัญชี SMTP จริง)
// net.connect() ส่งอาร์กิวเมนต์เข้า Socket.connect เป็น array — ต้องตรวจทั้ง 2 รูปแบบ (เดิมตรวจแบบเดียว ทำให้ SMTP รั่วออกไปได้)
const net = require('net');
const LOCAL = /^(localhost|127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    const host = o.path ? null : (o.host || o.hostname || 'localhost');
    if (host && !LOCAL.test(String(host))) {
        const err = new Error('blocked outbound connection to ' + host);
        process.nextTick(() => this.destroy(err));
        return this;
    }
    return origConnect.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (url, ...rest) => {
        const h = new URL(String(url && url.url ? url.url : url)).hostname.replace(/^\[|\]$/g, '');
        if (!LOCAL.test(h)) return Promise.reject(new Error('blocked fetch to ' + h));
        return origFetch(url, ...rest);
    };
}
