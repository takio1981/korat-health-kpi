// สคริปต์ที่ฉีดเข้าหน้าเว็บระหว่างถ่าย: น้องโคราชดี (ภาพเคลื่อนไหว), คำบรรยาย, เคอร์เซอร์, กรอบเน้น, การ์ดชื่อเรื่อง (ไม่แก้โค้ดระบบ)
module.exports = function overlayInit(M) {
    const VW = () => window.innerWidth, H_SMALL = 232, H_CARD = 500, FPS = 25;
    const S = { side: 'right', card: false, env: null, start: 0, dur: 0, point: 0, wave: 0, hop: 0, open: 0, blinkAt: 1800, blinkEnd: 0 };
    const mw = (h) => h * M.ratio;
    const $ = (q) => document.querySelector(q);

    function place() {
        const m = $('#vg-m'); if (!m) return;
        const h = S.card ? H_CARD : H_SMALL, w = mw(h);
        m.style.height = h + 'px'; m.style.width = w + 'px';
        m.style.left = (S.card ? 70 : S.side === 'right' ? VW() - w - 8 : 8) + 'px';
        m.style.bottom = (S.card ? 110 : 4) + 'px';
        m.classList.toggle('flip', !S.card && S.side === 'left');
        const c = $('#vg-cap');
        if (c) { c.classList.toggle('left', !S.card && S.side === 'left'); c.classList.toggle('card', S.card); }
    }

    function tick(now) {
        requestAnimationFrame(tick);
        const bd = $('#vg-m .bd'), hd = $('#vg-m .hd'), am = $('#vg-m .am'), mo = $('#vg-mo'), to = $('#vg-to'), ey = $('#vg-eyes');
        if (!bd) return;
        const t = now / 1000, talking = !!S.env && now - S.start < S.dur;
        const level = talking ? (S.env[Math.min(S.env.length - 1, Math.floor((now - S.start) / 1000 * FPS))] || 0) : 0;
        S.open += (level - S.open) * 0.55;
        const hop = Math.max(0, 1 - (now - S.hop) / 420), jump = Math.sin(hop * Math.PI) * 12;
        const bob = Math.sin(t * 2.1) * 2.4 + S.open * 1.6, sq = Math.sin(t * 2.1 + 1) * 0.006;
        bd.style.transform = `translateY(${(-bob - jump).toFixed(2)}px) scale(${(1 + sq).toFixed(4)},${(1 - sq).toFixed(4)})`;
        hd.style.transform = `rotate(${(Math.sin(t * 1.3) * 1.7 + (talking ? Math.sin(t * 5.1) * 1.5 * S.open : 0) + (S.point ? -2.5 : 0)).toFixed(2)}deg)`;
        const wave = Math.max(0, 1 - (now - S.wave) / 1500);
        const arm = S.point ? 6 + Math.sin(t * 7) * 2.5
            : wave > 0 ? Math.sin(t * 11) * 11 * wave + 5
                : Math.sin(t * 1.6) * 2.2 + (talking ? Math.sin(t * 3.7) * 3 * S.open : 0);
        am.style.transform = `rotate(${arm.toFixed(2)}deg)`;
        // ปาก: ยิ้มเมื่อเงียบ อ้าตามความดังของเสียง
        const o = talking ? S.open : 0, w = 15.5 - o * 2.5, h = 7 + o * 17, b = (h - 3).toFixed(1), c = (w * 0.86).toFixed(1);
        mo.setAttribute('d', `M${-w} -3Q0 ${(-1 + o).toFixed(1)} ${w} -3Q${c} ${b} 0 ${b}Q${-c} ${b} ${-w} -3Z`);
        to.setAttribute('cx', 0); to.setAttribute('cy', (h - 6.4).toFixed(1));
        to.setAttribute('rx', (w * 0.52).toFixed(1)); to.setAttribute('ry', Math.max(1, Math.min(4.6, h * 0.3)).toFixed(1));
        if (now > S.blinkAt) { S.blinkEnd = now + 125; S.blinkAt = now + 2300 + ((now * 7) % 2600); }
        ey.style.display = now < S.blinkEnd ? '' : 'none';
    }

    const make = () => {
        if (document.getElementById('vg-layer')) return;
        const st = document.createElement('style');
        st.textContent = `
#vg-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:Sarabun,'Noto Sans Thai',sans-serif}
#vg-card{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;padding-left:390px;
  background:linear-gradient(135deg,#065f46,#0f766e 55%,#155e75);color:#fff;text-align:center}
#vg-card .k{font-size:22px;opacity:.85;letter-spacing:.5px}#vg-card .t{font-size:42px;font-weight:800;margin:10px 30px;line-height:1.3}
#vg-card .s{font-size:23px;background:rgba(255,255,255,.15);padding:6px 22px;border-radius:999px;margin-top:8px}
#vg-ring{position:absolute;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 0 0 9999px rgba(15,23,42,.18),0 0 18px rgba(245,158,11,.9);display:none}
#vg-cap{position:absolute;bottom:16px;left:20px;right:196px;background:rgba(15,23,42,.9);color:#fff;padding:9px 18px 10px;border-radius:14px;
  font-size:20px;line-height:1.42;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none}
#vg-cap.left{left:196px;right:20px}#vg-cap.card{left:430px;right:40px}
#vg-cap b{display:inline-block;font-size:13px;font-weight:700;padding:1px 9px;border-radius:9px;margin-right:8px;vertical-align:2px;background:#14b8a6;color:#fff}
#vg-cur{position:absolute;left:-40px;top:-40px;width:22px;height:22px;border-radius:50%;background:rgba(250,204,21,.55);border:2px solid #f59e0b;transform:translate(-50%,-50%);transition:transform .12s}
#vg-cur.down{transform:translate(-50%,-50%) scale(.7);background:rgba(245,158,11,.85)}
#vg-m{position:absolute;left:0;bottom:4px;transition:left .45s ease,bottom .45s ease,height .45s ease,width .45s ease}
#vg-m .sh{position:absolute;left:18%;right:14%;bottom:-1%;height:5%;border-radius:50%;background:rgba(15,23,42,.28);filter:blur(4px)}
#vg-m .fl,#vg-m .bd,#vg-m .hd,#vg-m .am,#vg-m img,#vg-m svg{position:absolute;inset:0;width:100%;height:100%}
#vg-m .fl{transition:transform .3s}#vg-m.flip .fl{transform:scaleX(-1)}#vg-m.flip .se{transform:scaleX(-1)}
#vg-m svg{overflow:visible}`;
        document.head.appendChild(st);
        const L = document.createElement('div'); L.id = 'vg-layer';
        const [hx, hy] = M.pivots.head, [ax, ay] = M.pivots.arm, [sx] = M.pivots.seal, W = 281, H = 407;
        const P = ([x, y]) => [x * W / 100, y * H / 100];
        const [mx, my] = P(M.mouth), eye = M.eyes.map(P);
        const eyes = eye.map(([x, y]) => `<g transform="translate(${x} ${y}) rotate(8)"><ellipse rx="22" ry="29" fill="#2a2d30"/><path d="M-13 1Q0 10 13 1" fill="none" stroke="#5eead4" stroke-width="3.2" stroke-linecap="round"/></g>`).join('');
        L.innerHTML = `<div id="vg-card"><div class="k"></div><div class="t"></div><div class="s"></div></div><div id="vg-ring"></div><div id="vg-cap"></div>
<div id="vg-m"><div class="sh"></div><div class="fl"><div class="bd" style="transform-origin:50% 98%"><img src="${M.parts.body}"><img class="se" src="${M.parts.seal}" style="transform-origin:${sx}% 50%">
<div class="hd" style="transform-origin:${hx}% ${hy}%"><img src="${M.parts.head}"><svg viewBox="0 0 ${W} ${H}"><g id="vg-eyes" style="display:none">${eyes}</g>
<g transform="translate(${mx} ${my}) rotate(8)"><path id="vg-mo" fill="#7f1d2d" stroke="#f8fafc" stroke-width="1.3" stroke-linejoin="round"/><ellipse id="vg-to" fill="#fb7185"/></g></svg></div>
<div class="am" style="transform-origin:${ax}% ${ay}%"><img src="${M.parts.arm}"></div></div></div></div><div id="vg-cur"></div>`;
        document.body.appendChild(L);
        const cur = L.querySelector('#vg-cur');
        document.addEventListener('mousemove', e => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
        document.addEventListener('mousedown', () => cur.classList.add('down'), true);
        document.addEventListener('mouseup', () => cur.classList.remove('down'), true);
        place();
        requestAnimationFrame(tick);
    };

    window.__vg = {
        caption(text) {
            const el = $('#vg-cap'); if (!el) return;
            if (!text) { el.style.display = 'none'; return; }
            el.innerHTML = '<b>น้องโคราชดี</b>';
            el.appendChild(document.createTextNode(text));
            el.style.display = 'block';
        },
        say(env, ms) { S.env = env; S.start = performance.now(); S.dur = ms; S.hop = S.start; },
        ring(r) {
            const el = $('#vg-ring'); if (!el) return;
            if (!r) { el.style.display = 'none'; S.point = 0; return; }
            const p = 6;
            Object.assign(el.style, { left: (r.x - p) + 'px', top: (r.y - p) + 'px', width: (r.width + 2 * p) + 'px', height: (r.height + 2 * p) + 'px', display: 'block' });
            S.point = 1;
            // น้องย้ายไปอีกฝั่งเมื่อยืนบังเป้าหมาย
            const w = mw(H_SMALL) + 24, top = window.innerHeight - H_SMALL - 16;
            const hits = (side) => r.y + r.height > top && (side === 'right' ? r.x + r.width > VW() - w : r.x < w);
            if (hits(S.side)) { const other = S.side === 'right' ? 'left' : 'right'; if (!hits(other)) { S.side = other; place(); } }
        },
        card(kicker, title, sub) {
            const el = $('#vg-card'); if (!el) return;
            S.card = !!title; place();
            if (!title) { el.style.display = 'none'; return; }
            S.wave = performance.now();
            el.querySelector('.k').textContent = kicker || ''; el.querySelector('.t').textContent = title; el.querySelector('.s').textContent = sub || '';
            el.style.display = 'flex';
        },
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make); else make();

    // เบลอค่าที่อาจเป็นรหัสลับ/โทเคน/อีเมลในช่องกรอก (ฐานทดสอบมีค่าตั้งค่าจริงบางส่วน) — ไม่ให้ปรากฏในวิดีโอ
    setInterval(() => {
        document.querySelectorAll('input, textarea').forEach(el => {
            const v = String(el.value || '');
            const secret = el.type === 'password' ? v.length > 0 : (/^\S{16,}$/.test(v) || /@/.test(v) || /\S{24,}/.test(v));
            el.style.filter = secret ? 'blur(5px)' : '';
        });
    }, 250);
};
