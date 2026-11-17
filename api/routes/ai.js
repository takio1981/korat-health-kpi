// ผู้ช่วย AI (7 พ.ย. 2569) — สถานะ + ตั้งค่าผู้ให้บริการ (super_admin) + ทดสอบการเชื่อมต่อ
// ฟีเจอร์ที่ใช้ AI อยู่ในไฟล์ของโดเมนนั้น (เช่น /report/ai-summary ใน routes/reports.js) และเรียก services/ai.js
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin, saveLog } = require('../core/auth');
const { aiLimiter } = require('../core/security');
const { parseActiveFlag } = require('../core/validate');
const { requireAnyAction } = require('../core/access');
const { suggestFormula } = require('../services/ai-formula');
const { suggestKhdMappings } = require('../services/ai-khd');
const { askHelp } = require('../services/ai-help');
const { scanDataQuality } = require('../services/data-quality');
const { explainDataQuality, explainAnomalies } = require('../services/ai-quality');
const { AI_PROVIDERS, AI_AREAS, AI_AREA_KEYS, getAiSettings, saveAiSetting, encryptApiKey, usedToday, callLlm, sendAiError, listModels, AiError } = require('../services/ai');

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

// ทุก role ที่เข้าสู่ระบบ: หน้าจอใช้ซ่อน/แสดงปุ่ม AI
apiRouter.get('/ai/status', authenticateToken, async (req, res) => {
    try {
        const s = await getAiSettings();
        // features = ผลรวมแล้ว (ปิดรวม = ทุกส่วนปิด) — หน้าจอซ่อนปุ่ม AI ของส่วนที่ปิด
        res.json({ success: true, enabled: s.enabled, features: Object.fromEntries(AI_AREA_KEYS.map(k => [k, s.enabled && s.features[k]])) });
    } catch (e) {
        res.json({ success: true, enabled: false, features: {} });
    }
});

// ไม่คืนค่า API key (คืนเฉพาะ has_api_key) — แบบเดียวกับการตั้งค่า Google Drive
apiRouter.get('/ai/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const s = await getAiSettings();
        res.json({
            success: true,
            data: { enabled: s.enabled, provider: s.provider, base_url: s.base_url, model: s.model, daily_limit: s.daily_limit, has_api_key: !!s.api_key, used_today: await usedToday(),
                features: s.features, areas: AI_AREAS.map(a => ({ key: a.key, page: a.page, label: a.label })) },
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/ai/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const enabled = parseActiveFlag(b.enabled);
        if (enabled === null) return res.status(400).json({ success: false, message: 'กรุณาระบุสถานะเปิด/ปิดผู้ช่วย AI' });
        if (!AI_PROVIDERS.includes(b.provider)) return res.status(400).json({ success: false, message: 'ผู้ให้บริการ AI ไม่ถูกต้อง' });
        const baseUrl = String(b.base_url || '').trim();
        if (b.provider === 'openai' && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
            return res.status(400).json({ success: false, message: 'Base URL ต้องขึ้นต้นด้วย http:// หรือ https://' });
        }
        const model = String(b.model || '').trim();
        if (!model || model.length > 100) return res.status(400).json({ success: false, message: 'กรุณาระบุรุ่นโมเดล (ไม่เกิน 100 ตัวอักษร)' });
        const limit = parseInt(b.daily_limit, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 10000) return res.status(400).json({ success: false, message: 'จำนวนครั้งต่อวันต้องอยู่ระหว่าง 1–10,000' });

        // เปิด-ปิดรายส่วน (ไม่ส่ง = คงค่าเดิม, ส่งบางส่วน = รวมกับค่าเดิม) — รับเฉพาะ key ที่รู้จัก ค่าต้องเป็น true/false
        let featNote = '';
        if (b.features !== undefined) {
            if (!b.features || typeof b.features !== 'object' || Array.isArray(b.features)) return res.status(400).json({ success: false, message: 'รูปแบบการเปิด-ปิดรายหน้าไม่ถูกต้อง' });
            const cur = (await getAiSettings()).features;
            const next = { ...cur };
            for (const k of Object.keys(b.features)) {
                if (!AI_AREA_KEYS.includes(k)) return res.status(400).json({ success: false, message: 'ไม่รู้จักส่วนที่ใช้ AI: ' + String(k).slice(0, 40) });
                if (typeof b.features[k] !== 'boolean') return res.status(400).json({ success: false, message: 'ค่าการเปิด-ปิดรายหน้าต้องเป็น true/false' });
                next[k] = b.features[k];
            }
            await saveAiSetting('ai_features', JSON.stringify(next));
            const off = AI_AREAS.filter(a => !next[a.key]).map(a => a.label);
            featNote = off.length ? ' / ปิดรายหน้า: ' + off.join(', ') : ' / เปิดทุกหน้า';
        }
        await saveAiSetting('ai_enabled', enabled ? 'true' : 'false');
        await saveAiSetting('ai_provider', b.provider);
        await saveAiSetting('ai_base_url', baseUrl);
        await saveAiSetting('ai_model', model);
        await saveAiSetting('ai_daily_limit', String(limit));
        const key = typeof b.api_key === 'string' ? b.api_key.trim() : '';
        if (b.clear_api_key === true) await saveAiSetting('ai_api_key_enc', '');
        else if (key) await saveAiSetting('ai_api_key_enc', encryptApiKey(key)); // ส่งว่าง = คงค่าเดิม

        await saveLog(req.user.username, 'AI_SETTINGS_UPDATE',
            `ผู้ช่วย AI: ${enabled ? 'เปิด' : 'ปิด'} / ${b.provider} / ${model} / ${limit} ครั้งต่อวัน${key ? ' / เปลี่ยน API key' : ''}${b.clear_api_key === true ? ' / ลบ API key' : ''}${featNote}`,
            clientIp(req));
        res.json({ success: true, message: 'บันทึกการตั้งค่าผู้ช่วย AI แล้ว' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// รายชื่อรุ่นโมเดลจากผู้ให้บริการ (ครบทุกรุ่น + อัปเดตได้เมื่อมีรุ่นใหม่) — refresh = ดึงใหม่จากผู้ให้บริการ, ไม่ส่ง = ใช้ผลล่าสุดที่เก็บไว้
// api_key ใน body ใช้เฉพาะครั้งนี้ (ไม่บันทึก) — ว่าง = ใช้ key ที่บันทึกไว้ของผู้ให้บริการเดียวกัน
apiRouter.post('/ai/models', authenticateToken, isSuperAdmin, aiLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await listModels({ provider: b.provider, base_url: b.base_url, api_key: b.api_key, refresh: b.refresh === true });
        res.json({ success: true, ...out });
    } catch (e) {
        sendAiError(res, e, 'ดึงรายชื่อรุ่นโมเดลไม่สำเร็จ');
    }
});

// ระยะที่ 2: ช่วยเขียนสูตรคำนวณผลงาน/สูตรร้อยละ (หน้าจัดการตัวชี้วัด — สิทธิ์เพิ่มหรือแก้ไขตัวชี้วัด) — คืนเฉพาะสูตรที่ผ่านตัวตรวจของระบบ ไม่บันทึกให้
apiRouter.post('/ai/formula-suggest', authenticateToken, requireAnyAction('kpi-manage', ['add', 'edit']), aiLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await suggestFormula({ description: b.description, kind: b.kind, custom_vars: b.custom_vars, target_condition: b.target_condition, indicator_name: b.indicator_name, indicator: b.indicator }, req.user.userId);
        res.json({ success: true, ...out });
    } catch (e) {
        sendAiError(res, e, 'AI ช่วยเขียนสูตรไม่สำเร็จ');
    }
});

// ระยะที่ 3: เสนอการจับคู่ค่าใน KHD กับหน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของระบบ (หน้าต่างจับคู่ข้อมูล KHD — super_admin เท่านั้นเหมือน /khd-mappings)
// คืนเฉพาะ id ที่อยู่ในตัวเลือกจริง ไม่บันทึกให้ — ผู้ดูแลกด "จับคู่" เอง (PUT /khd-mappings)
apiRouter.post('/ai/khd-mapping-suggest', authenticateToken, isSuperAdmin, aiLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await suggestKhdMappings({ kind: b.kind, khd_values: b.khd_values }, req.user.userId);
        res.json({ success: true, ...out });
    } catch (e) {
        if (!(e instanceof AiError) && e.status) return res.status(e.status).json({ success: false, message: e.message });
        sendAiError(res, e, 'AI เสนอการจับคู่ไม่สำเร็จ');
    }
});

// ระยะที่ 4: ผู้ช่วยตอบคำถามการใช้งานจากคู่มือ (ทุก role ที่เปิดหน้าคู่มือได้ — PAGE_ACCESS_RULES pageKey help)
// ค้นเฉพาะหัวข้อคู่มือที่ role ของผู้ถามเห็น (data/help-kb.json) แล้วให้ AI ตอบจากเนื้อหานั้นพร้อมอ้างหัวข้อ — ไม่พบ = ไม่เรียก AI
apiRouter.post('/ai/help-ask', authenticateToken, aiLimiter, async (req, res) => {
    try {
        const out = await askHelp({ question: (req.body || {}).question }, req.user);
        res.json({ success: true, ...out });
    } catch (e) {
        sendAiError(res, e, 'ผู้ช่วยคู่มือตอบไม่สำเร็จ');
    }
});

// ระยะที่ 5 (ก): สรุปผลตรวจคุณภาพข้อมูลทั้งปีงบ (หน้าจัดการข้อมูลผลงาน — super_admin) — server ตรวจใหม่เสมอ ไม่รับผลตรวจจาก client
// ไม่พบรายการ = ไม่เรียก AI | ส่งเฉพาะจำนวน/ชื่อตัวชี้วัด/ตัวอย่างค่า (ไม่มีรหัส/ชื่อหน่วยบริการ)
apiRouter.post('/ai/data-quality-explain', authenticateToken, isSuperAdmin, aiLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const scan = await scanDataQuality(b.year_bh);
        const out = await explainDataQuality(scan, req.user.userId, { refresh: b.refresh === true });
        res.json({ success: true, ...out });
    } catch (e) {
        if (!(e instanceof AiError) && e.status) return res.status(e.status).json({ success: false, message: e.message });
        sendAiError(res, e, 'AI สรุปผลตรวจคุณภาพข้อมูลไม่สำเร็จ');
    }
});

// ระยะที่ 5 (ข): อธิบายคำเตือนค่าที่อาจผิดปกติของช่องที่กำลังแก้ในหน้าบันทึกผลงาน (ยังไม่บันทึก) — เตือนเท่านั้น ไม่ห้ามบันทึก
// server คำนวณคำเตือนใหม่ด้วย detectAnomaly() และอ่านชื่อตัวชี้วัดจากฐานข้อมูล (ตามขอบเขตหน่วยงาน) — ไม่ส่งรหัสหน่วยบริการเข้า prompt
apiRouter.post('/ai/anomaly-explain', authenticateToken, aiLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await explainAnomalies(b.items, req.user, { refresh: b.refresh === true });
        res.json({ success: true, ...out });
    } catch (e) {
        sendAiError(res, e, 'AI อธิบายค่าที่อาจผิดปกติไม่สำเร็จ');
    }
});

// ทดสอบด้วยค่าที่บันทึกไว้ (ทำงานได้แม้ยังปิด — ให้ตรวจก่อนเปิดใช้) ไม่นับโควตา
apiRouter.post('/ai/test', authenticateToken, isSuperAdmin, aiLimiter, async (req, res) => {
    try {
        const out = await callLlm({
            feature: 'test', userId: req.user.userId, test: true, maxTokens: 200,
            system: 'คุณเป็นผู้ช่วยของระบบบันทึกผลงานตัวชี้วัดด้านสุขภาพ ตอบเป็นภาษาไทยสั้นๆ',
            prompt: 'ตอบกลับประโยคเดียวว่า "ผู้ช่วย AI พร้อมใช้งาน" และบอกชื่อรุ่นของคุณ',
        });
        res.json({ success: true, text: out.text, model: out.model, provider: out.provider, ms: out.ms });
    } catch (e) {
        sendAiError(res, e, 'ทดสอบผู้ช่วย AI ไม่สำเร็จ');
    }
});
