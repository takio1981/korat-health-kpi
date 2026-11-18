// สคริปต์ที่ฉีดเข้าหน้าเว็บระหว่างถ่าย: คำบรรยายใต้ภาพ, เคอร์เซอร์, กรอบเน้น, การ์ดชื่อเรื่อง (ไม่แก้โค้ดระบบ)
module.exports = function overlayInit() {
    const make = () => {
        if (document.getElementById('vg-layer')) return;
        const st = document.createElement('style');
        st.textContent = `
#vg-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:Sarabun,'Noto Sans Thai',sans-serif}
#vg-cap{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);max-width:1040px;background:rgba(15,23,42,.86);color:#fff;
  padding:10px 20px 11px;border-radius:14px;font-size:21px;line-height:1.45;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none}
#vg-cap .who{display:inline-block;font-size:13px;font-weight:700;padding:1px 9px;border-radius:9px;margin-right:8px;vertical-align:3px}
#vg-cap .who.f{background:#ec4899}#vg-cap .who.m{background:#0ea5e9}
#vg-cur{position:absolute;left:-40px;top:-40px;width:22px;height:22px;border-radius:50%;background:rgba(250,204,21,.55);border:2px solid #f59e0b;
  transform:translate(-50%,-50%);transition:transform .12s}
#vg-cur.down{transform:translate(-50%,-50%) scale(.7);background:rgba(245,158,11,.85)}
#vg-ring{position:absolute;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 0 0 9999px rgba(15,23,42,.18),0 0 18px rgba(245,158,11,.9);display:none;transition:all .25s}
#vg-card{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;
  background:linear-gradient(135deg,#065f46,#0f766e 55%,#155e75);color:#fff;text-align:center}
#vg-card .k{font-size:22px;opacity:.85;letter-spacing:.5px}#vg-card .t{font-size:46px;font-weight:800;margin:10px 40px}
#vg-card .s{font-size:24px;background:rgba(255,255,255,.15);padding:6px 22px;border-radius:999px;margin-top:8px}`;
        document.head.appendChild(st);
        const L = document.createElement('div'); L.id = 'vg-layer';
        L.innerHTML = '<div id="vg-card"><div class="k"></div><div class="t"></div><div class="s"></div></div><div id="vg-ring"></div><div id="vg-cap"></div><div id="vg-cur"></div>';
        document.body.appendChild(L);
        const cur = L.querySelector('#vg-cur');
        document.addEventListener('mousemove', e => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
        document.addEventListener('mousedown', () => cur.classList.add('down'), true);
        document.addEventListener('mouseup', () => cur.classList.remove('down'), true);
        const st0 = window.__vgState || {};
        if (st0.cap) window.__vg.caption(st0.cap.text, st0.cap.who);
    };
    window.__vg = {
        caption(text, who) {
            window.__vgState = { cap: text ? { text, who } : null };
            const el = document.getElementById('vg-cap'); if (!el) return;
            if (!text) { el.style.display = 'none'; return; }
            el.innerHTML = '';
            if (who) { const w = document.createElement('span'); w.className = 'who ' + who; w.textContent = who === 'f' ? 'ผู้บรรยายหญิง' : 'ผู้บรรยายชาย'; el.appendChild(w); } el.appendChild(document.createTextNode(text)); el.style.display = 'block';
        },
        ring(r) {
            const el = document.getElementById('vg-ring'); if (!el) return;
            if (!r) { el.style.display = 'none'; return; }
            const p = 6; Object.assign(el.style, { left: (r.x - p) + 'px', top: (r.y - p) + 'px', width: (r.width + 2 * p) + 'px', height: (r.height + 2 * p) + 'px', display: 'block' });
        },
        card(kicker, title, sub) {
            const el = document.getElementById('vg-card'); if (!el) return;
            if (!title) { el.style.display = 'none'; return; }
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
