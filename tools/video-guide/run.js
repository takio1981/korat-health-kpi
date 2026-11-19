/**
 * สร้างวิดีโอคู่มือ — node run.js [--role=user_hos,admin_ssj] [--only=dashboard,charts] [--skip-existing]
 * ต้องมี backend ทดสอบ :3710 (node start-backend.js), frontend :4520 (ng serve --port 4520) และ node setup-data.js up
 * ผลลัพธ์: <repo>/videos/<สิทธิ์>/<หัวข้อ>.mp4 + videos/manifest.json (ไม่อยู่ใน git — ดู README.md)
 */
const fs = require('fs');
const path = require('path');
const { launch, loginState } = require('./lib/browser');
const { record, OUT } = require('./lib/engine');
const { ROLES, ROLE_KEYS } = require('./lib/roles');
const { resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');
const SCRIPTS = require('./scripts');
const { loadMascot } = require('./build-mascot');

const arg = (k) => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1];
const roleFilter = arg('role') ? arg('role').split(',') : null;
const onlyFilter = arg('only') ? arg('only').split(',') : null;
const skipExisting = process.argv.includes('--skip-existing');
const MANIFEST = path.join(OUT, 'manifest.json');

function loadManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { videos: {} }; } }
function saveManifest(m) { for (const [k, v] of Object.entries(m.videos)) if (!fs.existsSync(path.join(OUT, v.file))) delete m.videos[k]; m.generated = new Date().toISOString(); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1)); }

(async () => {
    const mascot = await loadMascot();
    const browser = await launch();
    const manifest = loadManifest();
    const report = [];
    // public (ไม่ต้องเข้าสู่ระบบ) ก่อน แล้วตามสิทธิ์
    const groups = [['public', null], ...ROLE_KEYS.map(k => [k, ROLES[k]])].filter(([k]) => !roleFilter || roleFilter.includes(k));
    for (const [roleKey, role] of groups) {
        const list = SCRIPTS.filter(s => (roleKey === 'public' ? s.roles === 'public' : (s.roles === 'all' || (Array.isArray(s.roles) && s.roles.includes(roleKey)))))
            .filter(s => !onlyFilter || onlyFilter.includes(s.id));
        if (!list.length) continue;
        let state = null;
        for (const s of list) {
            const outName = `${roleKey}/${s.id}.mp4`;
            if (skipExisting && fs.existsSync(path.join(OUT, outName))) { console.log('ข้าม', outName); continue; }
            if (roleKey === 'public') await resetSessions();
            if (!state && roleKey !== 'public') { await resetSessions(); state = await loginState(browser, 'test_vg_' + roleKey, PASSWORD); }
            console.log(`▶ ${outName}`);
            const r = role || { short: 'ผู้ใช้งานทั่วไป', label: 'ผู้ใช้งานทั่วไป' };
            const t = Date.now();
            try {
                const res = await record(browser, {
                    id: s.id, title: s.title, roleLabel: roleKey === 'public' ? 'ทุกสิทธิ์การใช้งาน' : 'สิทธิ์: ' + r.label,
                    start: s.start, before: s.before, storageState: roleKey === 'public' ? undefined : state, steps: s.steps(r, roleKey).filter(Boolean), outName, mascot,
                });
                manifest.videos[`${roleKey}/${s.id}`] = { title: s.title, role: roleKey, section: s.id, file: outName, duration: Math.round(res.ms / 1000), size: res.size, updated: new Date().toISOString() };
                saveManifest(manifest);
                report.push({ outName, sec: Math.round(res.ms / 1000), mb: (res.size / 1048576).toFixed(1), warnings: res.warnings.length, took: Math.round((Date.now() - t) / 1000) });
                console.log(`  ✓ ${Math.round(res.ms / 1000)} วินาที ${(res.size / 1048576).toFixed(1)} MB${res.warnings.length ? ' ⚠ ' + res.warnings.length : ''}`);
                res.uncovered.forEach(u => console.log('    ⛉ แก้การบัง:', u));
            } catch (e) {
                console.log('  ✗', e.message);
                report.push({ outName, error: e.message });
            }
        }
    }
    await browser.close();
    console.table(report);
})().catch(e => { console.error(e); process.exit(1); });
