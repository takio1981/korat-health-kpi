// preload: บล็อกการเชื่อมต่อออกนอกเครื่อง (ฐานทดสอบมีโทเคน LINE/Telegram/SMTP จริง)
const net = require('net');
const LOCAL = /^(localhost|127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    const host = o && (o.host || o.hostname);
    if (host && !LOCAL.test(String(host)) && !o.path) {
        const err = new Error('blocked outbound connection to ' + host);
        process.nextTick(() => this.destroy(err));
        return this;
    }
    return origConnect.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (url, ...rest) => {
        const h = new URL(String(url && url.url ? url.url : url)).hostname;
        if (!LOCAL.test(h)) return Promise.reject(new Error('blocked fetch to ' + h));
        return origFetch(url, ...rest);
    };
}
