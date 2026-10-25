// สิทธิ์: กลุ่ม role, ขอบเขต (dept/hospcode/อำเภอ), สิทธิ์เข้าหน้า/เพิ่ม-แก้ไข (role_page_access/role_action_access + แคช), สิทธิ์รายผู้ใช้
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');

// ============================================================================
// === Role × Page Access — Super Admin เปิด/ปิดการเข้าถึงแต่ละหน้าต่อ Role ===
// ============================================================================
// pageKey ต้องตรงกับ path ใน frontend app.routes.ts (route.data.pageKey) เพื่อให้ sidebar/guard
// ฝั่ง frontend และ enforcement ฝั่ง backend อ้างอิง key เดียวกัน
const PAGE_ACCESS_ROLES = ['admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso', 'user_cup', 'user_hos', 'user_sso', 'user_ssj'];
// super_admin ไม่เก็บ row — เข้าได้ทุกหน้าเสมอ (hardcode ผ่าน hasPageAccess ด้านล่าง กันปิดตัวเองไม่ได้)
const PAGE_ACCESS_PAGES = [
    { key: 'dashboard', label: 'บันทึกผลงานตัวชี้วัด' },
    { key: 'charts', label: 'รายงานสถิติ' },
    { key: 'notifications', label: 'แจ้งเตือน' },
    { key: 'sop', label: 'ผังกระบวนการ SOP' },
    { key: 'feedback', label: 'กระดานข้อเสนอแนะ' },
    { key: 'help', label: 'คู่มือการใช้งาน' },
    { key: 'changelog', label: 'ประวัติการอัปเดต' },
    { key: 'users', label: 'จัดการผู้ใช้งาน' },
    { key: 'kpi-manage', label: 'จัดการตัวชี้วัด' },
    { key: 'kpi-setup', label: '+KPI ปีงบประมาณใหม่' },
    { key: 'audit-logs', label: 'ประวัติการใช้งาน' },
    { key: 'kpi-manager', label: 'จัดการข้อมูล KPI ↔ KHD' },
    { key: 'settings', label: 'ตั้งค่าระบบ' },
    { key: 'announcements', label: 'ประกาศระบบ' },
    { key: 'online-users', label: 'ผู้ใช้งานออนไลน์' },
    { key: 'backup-manager', label: 'สำรอง & กู้คืนข้อมูล' },
    { key: 'kpi-audit-digest', label: 'แจ้งเตือนการบันทึก KPI' },
    { key: 'error-logs', label: 'Error Logs' },
    { key: 'sso-logs', label: 'SSO Audit Logs' },
    { key: 'kpi-results-manage', label: 'จัดการข้อมูลผลงานตัวชี้วัด' },
];
// ค่าเริ่มต้น (seed ครั้งแรกเท่านั้น) — สะท้อนพฤติกรรมเดิมของระบบก่อนมี feature นี้ทุกประการ
// (route guard เดิมใน app.routes.ts + isAdmin/isAnyAdmin/isSuperAdmin เดิมในแต่ละ endpoint)
// ไม่ list role ในหน้าไหน = ปิดเริ่มต้นสำหรับหน้านั้น
const ROLES_ALL_LOGGED_IN = ['admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso', 'user_cup', 'user_hos', 'user_sso', 'user_ssj'];
const ROLES_ANY_ADMIN = ['admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso']; // ตรงกับ ROLE_ADMIN_ALL (ไม่รวม super_admin)
const PAGE_ACCESS_DEFAULT_ENABLED = {
    dashboard: ROLES_ALL_LOGGED_IN,
    charts: ROLES_ALL_LOGGED_IN,
    notifications: ROLES_ALL_LOGGED_IN,
    sop: ROLES_ALL_LOGGED_IN,
    feedback: ROLES_ALL_LOGGED_IN,
    help: ROLES_ALL_LOGGED_IN,
    changelog: ROLES_ALL_LOGGED_IN,
    users: ROLES_ANY_ADMIN,
    'kpi-manage': ['admin_ssj'], // ตรงกับ ROLE_ADMIN_CENTRAL (isAdmin เดิม)
    'kpi-setup': [], // route guard เดิม = superAdminGuard เท่านั้น
    'audit-logs': [],
    'kpi-manager': [],
    settings: [],
    announcements: [],
    'online-users': [],
    'backup-manager': [],
    'kpi-audit-digest': [],
    'error-logs': [],
    'sso-logs': [],
    'kpi-results-manage': [], // super_admin เท่านั้น (ตามที่ผู้ใช้ระบุไว้ชัดเจน) — หน้าใหม่จึงเริ่มปิดสำหรับ role อื่นทั้งหมด
};

// Cache ในหน่วยความจำ — role -> Set<pageKey ที่เปิดใช้งาน> โหลดตอน startup + reload เมื่อมีการบันทึกค่าใหม่
const _rolePageAccessCache = new Map();
async function loadRolePageAccessCache() {
    try {
        const [rows] = await db.query('SELECT role, page_key FROM role_page_access WHERE is_enabled = 1');
        const next = new Map();
        for (const r of rows) {
            if (!next.has(r.role)) next.set(r.role, new Set());
            next.get(r.role).add(r.page_key);
        }
        _rolePageAccessCache.clear();
        for (const [k, v] of next) _rolePageAccessCache.set(k, v);
    } catch (e) {
        console.error('❌ loadRolePageAccessCache failed:', e.message);
    }
}
// super_admin เข้าได้ทุกหน้าเสมอ (hardcode กันตั้งค่าผิดพลาดจนตัวเองเข้าระบบไม่ได้)
function hasPageAccess(role, pageKey) {
    if (role === 'super_admin') return true;
    if (!pageKey) return false;
    const set = _rolePageAccessCache.get(role);
    return !!(set && set.has(pageKey));
}

// === Path → pageKey resolver สำหรับ enforcement ฝั่ง backend ===
// สำคัญมาก — กันไม่ให้เปิดสิทธิ์เกินของเดิมโดยไม่ตั้งใจ (over-grant): endpoint หลายกลุ่มใน server.js มี
// authorization ปนกันหลายระดับใต้ path เดียวกัน (isAnyAdmin/isAdmin/isSuperAdmin ปนกัน หรือแม้แต่เปิดให้ทุก role)
// เช่น /users มีทั้ง endpoint isAnyAdmin (จัดการผู้ใช้ทั่วไป) และ isAdmin (approve/reject) และ isSuperAdmin
// (permissions/sync-to-khd) ปนกัน — ห้าม map ด้วย prefix กว้างๆ เด็ดขาดเพราะจะทำให้ role ที่ถูก seed
// ให้เข้าหน้านี้ได้ (ตรงกับ tier ที่กว้างที่สุด) ได้สิทธิ์ทำ action ระดับที่แคบกว่าไปด้วยทั้งที่ไม่เคยมีสิทธิ์มาก่อน
// หลักการ: pageKey หนึ่งจะรวม endpoint ได้ก็ต่อเมื่อทุก role ที่ default เปิดหน้านั้น มีสิทธิ์ endpoint นั้นอยู่แล้วจริง
// endpoint ที่ authorization เข้มกว่า default ของหน้า (เช่น kpi-manage.html เองก็ซ่อนปุ่มแก้ไข/ลบ/Form Builder
// จาก admin_ssj ด้วย *ngIf="isSuperAdmin" ทั้งหมด เหลือแค่ "เพิ่มจำนวนมาก" ที่ admin_ssj ใช้ได้จริง) จะถูกคงไว้
// เป็น isSuperAdmin ตรงๆ ไม่ผ่านระบบนี้ — Super Admin ยังคุมได้อยู่ดีเพราะเป็น super_admin เข้าได้ทุกอย่างเสมอ
// เพียงแต่ "เปิดให้ role อื่นแก้ไข/ลบตัวชี้วัด" ยังทำไม่ได้ผ่านหน้านี้ (นอกขอบเขตที่ตั้งใจในรอบนี้)

// เรียงจากเฉพาะเจาะจง → กว้าง — ตัวแรกที่ match ถูกใช้เสมอ (rule ที่มี pageKey: null = endpoint ยกเว้น ไม่ gate)
const PAGE_ACCESS_RULES = [
    // ข้อยกเว้น — endpoint ที่ใช้ได้ทุก role แม้ path จะขึ้นต้นเหมือน endpoint เฉพาะ admin
    { method: 'PUT', path: '/users/change-password', pageKey: null },
    // ข้อยกเว้น — 'bulk-toggle-active' ไม่มี '/' จึงหน้าตาเหมือน :id ห้ามให้ regex /users/:id ด้านล่างจับ (เดิม isSuperAdmin ไม่ใช่ isAnyAdmin)
    { method: 'PUT', path: '/users/bulk-toggle-active', pageKey: null },

    // หน้าเปิดทั่วไป — gate เฉพาะ endpoint หลักที่อ่านข้อมูลของหน้านั้นโดยตรง (ปลอดภัย ไม่กระทบ endpoint ย่อยที่ใช้ร่วมกันข้ามหน้า เช่น notifications/unread-count)
    { method: 'GET', path: '/kpi-results', pageKey: 'dashboard' },
    // จัดการข้อมูลผลงานตัวชี้วัด — เฉพาะ GET (list) เข้าระบบนี้ได้ ส่วน bulk-delete hardcode isSuperAdmin ตรงๆ
    // เสมอ (ตามกฎ DELETE ทุกตัวของระบบ) ไม่เข้า PAGE_ACCESS_RULES เด็ดขาด กันเปิดสิทธิ์ลบผ่านการตั้งค่านี้
    { method: 'GET', path: '/kpi-results/manage', pageKey: 'kpi-results-manage' },
    { method: 'GET', path: '/kpi-setup-check', pageKey: 'kpi-setup' },
    { method: 'GET', path: '/notifications', pageKey: 'notifications' },
    { method: 'GET', path: '/feedback', pageKey: 'feedback' },
    { prefix: '/report/', pageKey: 'charts' },

    // settings (กลุ่มนี้ทั้งหมด isSuperAdmin เดิม ไม่มี endpoint เปิดปนอยู่ — ยืนยันแล้ว ปลอดภัยใช้ prefix กว้าง)
    { method: 'POST', path: '/settings', pageKey: 'settings' },
    { prefix: '/env-config', pageKey: 'settings' },
    { prefix: '/test-telegram', pageKey: 'settings' },
    { prefix: '/test-line', pageKey: 'settings' },
    { prefix: '/test-admin-email', pageKey: 'settings' },
    { prefix: '/admin/line-inbox', pageKey: 'settings' },
    { prefix: '/admin/users/', pageKey: 'settings' },
    { path: '/system/maintenance-mode', pageKey: 'settings' },

    // users — เฉพาะ endpoint ที่เดิมเป็น isAnyAdmin เท่านั้น (ตรงกับ default seed ROLES_ANY_ADMIN)
    // ไม่รวม: bulk-toggle-active/permissions/sync-compare/sync-to-khd (isSuperAdmin เดิม) และ
    // approve/reject/toggle-active/basic (isAdmin เดิม — admin_ssj+super_admin เท่านั้น) — คงไว้ตามเดิมทุกจุด
    // structure-compare/sync-mapping (GET+PUT) ก็ hardcode isSuperAdmin เหมือนกลุ่ม sync-compare/sync-to-khd ข้างต้น — ไม่เพิ่มเข้า rules นี้เช่นกัน
    { method: 'GET',  path: '/users', pageKey: 'users' },
    { method: 'GET',  path: '/users/stats', pageKey: 'users' },
    { method: 'GET',  path: '/users/pending-count', pageKey: 'users' },
    { method: 'POST', path: '/users', pageKey: 'users' },
    { method: 'PUT',  re: /^\/users\/[^/]+$/, pageKey: 'users' },
    { method: 'DELETE', re: /^\/users\/[^/]+$/, pageKey: 'users' },
    { method: 'PUT',  re: /^\/users\/[^/]+\/reset-password$/, pageKey: 'users' },

    // kpi-manage — เฉพาะ bulk-add-kpi (isAdmin เดิม) เท่านั้น ตรงกับที่ admin_ssj ใช้ได้จริงวันนี้
    // (แก้ไข/ลบตัวชี้วัด/หมวดหมู่/หน่วยงาน/หน่วยบริการ/Form Builder ทั้งหมด — kpi-manage.html ซ่อนปุ่มจาก
    // admin_ssj ด้วย *ngIf="isSuperAdmin" อยู่แล้ว จึงคงเป็น isSuperAdmin ตรงๆ ไม่ผ่านระบบนี้)
    { method: 'GET',  path: '/bulk-add-kpi/preview', pageKey: 'kpi-manage' },
    { method: 'POST', path: '/bulk-add-kpi', pageKey: 'kpi-manage' },

    // audit-logs
    { path: '/system-logs', pageKey: 'audit-logs' },

    // kpi-manager (Export/Sync/DB Compare/Report Compare ↔ KHD — ทั้งหมด isSuperAdmin เดิม ไม่มี endpoint เปิด)
    { prefix: '/export-schedules', pageKey: 'kpi-manager' },
    { prefix: '/sync-to-khd', pageKey: 'kpi-manager' },
    { prefix: '/db-compare', pageKey: 'kpi-manager' },
    { prefix: '/export-kpi-tables', pageKey: 'kpi-manager' },
    { prefix: '/report-compare', pageKey: 'kpi-manager' },
    { prefix: '/check-kpi-export', pageKey: 'kpi-manager' },
    { prefix: '/exportable-indicators', pageKey: 'kpi-manager' },
    { prefix: '/refresh-summary', pageKey: 'kpi-manager' },

    // announcements / online-users / sso-logs / error-logs / kpi-audit-digest / backup-manager
    { prefix: '/announcements', pageKey: 'announcements' },
    { prefix: '/online-users', pageKey: 'online-users' },
    { prefix: '/admin/sso-', pageKey: 'sso-logs' },
    { prefix: '/admin/error-logs', pageKey: 'error-logs' },
    { prefix: '/logs/', pageKey: 'error-logs' },
    { prefix: '/kpi-audit', pageKey: 'kpi-audit-digest' },
    { prefix: '/backup', pageKey: 'backup-manager' },
    { prefix: '/clear-kpi-data', pageKey: 'backup-manager' },
];

function resolvePageKeyFromPath(method, path) {
    for (const rule of PAGE_ACCESS_RULES) {
        if (rule.method && rule.method !== method) continue;
        if (rule.path !== undefined) { if (path === rule.path) return rule.pageKey; continue; }
        if (rule.re) { if (rule.re.test(path)) return rule.pageKey; continue; }
        if (rule.prefix !== undefined) { if (path.startsWith(rule.prefix)) return rule.pageKey; continue; }
    }
    return null; // ไม่พบ mapping — endpoint นี้ไม่ถูกควบคุมด้วยระบบสิทธิ์หน้า (คงพฤติกรรมเดิม)
}

// ============================================================================
// === Role × Action Access — สิทธิ์ "เพิ่ม"/"แก้ไข" ข้อมูลแยกต่างหากจากสิทธิ์เข้าหน้า ===
// ============================================================================
// เป็นคนละมิติกับ role_page_access (การเข้าหน้า/เห็นเมนู) โดยตั้งใจ — independent เช็คเอง
// ไม่ผูกกับ hasPageAccess เลย เพราะบาง endpoint เดิม bundle ทั้งอ่าน+เขียนไว้ใต้ pageKey เดียว
// (เช่น /users) ถ้าผูกซ้อนกันจะยุ่งยากเกินจำเป็น — ระบบนี้แค่เพิ่มเงื่อนไข "เขียนได้ไหม" อีกชั้น
// บน endpoint ที่เป็น POST (add) / PUT (edit) เท่านั้น — DELETE ยังคง hardcode isSuperAdmin
// เสมอทุกจุดตามกติกาเดิมของระบบ (ปุ่มลบ = super_admin เท่านั้น ไม่มีข้อยกเว้น)
//
// ขอบเขตที่ตั้งใจไม่ครอบคลุม (เก็บพฤติกรรมเดิมไว้ hardcode เหมือนเดิมทุกจุด — เหตุผลดูแต่ละจุด):
// - users: approve/reject/toggle-active/basic (isAdmin เดิม, เข้มกว่า isAnyAdmin ของ view) และ
//   permissions/bulk-toggle-active/sync-compare/sync-to-khd (isSuperAdmin เดิม) — เป็น action
//   คนละระดับกับ "แก้ไขข้อมูลผู้ใช้ทั่วไป" (อนุมัติ/สิทธิ์พิเศษ/sync ข้ามระบบ) ไม่ใช่ "เพิ่ม/แก้ไข" ตรงๆ
// - kpi-manage: GET .../result-summary, GET /form-schemas/all-indicators เป็น read ไม่ใช่เขียน
// - announcements: POST .../send-email เป็น action แจ้งเตือน ไม่ใช่เพิ่ม/แก้ไขข้อมูลประกาศ
// - dashboard/kpi-setup: ไม่รวมในรอบนี้ — endpoint หลัก (/update-kpi) ใช้ authenticateToken
//   ตรงๆ ไม่ผ่าน middleware กลาง + มี per-user permission (can_edit_actual/can_edit_target ใน
//   ตาราง users) อยู่แล้วซึ่งเป็นกลไกคนละชั้น เสี่ยงเกินไปที่จะแตะในรอบนี้
const ACTION_ACCESS_ROLES = PAGE_ACCESS_ROLES; // 8 role เดียวกัน (ไม่รวม super_admin)
const ACTION_ACCESS_PAGES = [
    { key: 'kpi-manage', label: 'จัดการตัวชี้วัด' },
    { key: 'users', label: 'จัดการผู้ใช้งาน' },
    { key: 'announcements', label: 'ประกาศระบบ' },
];
const ACTION_TYPES = ['add', 'edit'];
// ค่าเริ่มต้น — ตรงกับ middleware เดิมของแต่ละ endpoint เป๊ะ (ดู comment เหนือ endpoint ที่แก้แต่ละจุด)
const ACTION_ACCESS_DEFAULT_ENABLED = {
    'kpi-manage:add': [],  // เดิม isSuperAdmin ล้วน — admin_ssj เองก็ทำไม่ได้ (kpi-manage.html ซ่อนปุ่มด้วย *ngIf="isSuperAdmin")
    'kpi-manage:edit': [],
    'users:add': ['admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'],  // เดิม isAnyAdmin
    'users:edit': ['admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'], // เดิม isAnyAdmin (PUT /users/:id, reset-password)
    'announcements:add': [],  // เดิม isSuperAdmin ล้วน
    'announcements:edit': [],
};

const _roleActionAccessCache = new Map(); // role -> Map<pageKey, Set<action>>
async function loadRoleActionAccessCache() {
    try {
        const [rows] = await db.query('SELECT role, page_key, action FROM role_action_access WHERE is_enabled = 1');
        const next = new Map();
        for (const r of rows) {
            if (!next.has(r.role)) next.set(r.role, new Map());
            const pageMap = next.get(r.role);
            if (!pageMap.has(r.page_key)) pageMap.set(r.page_key, new Set());
            pageMap.get(r.page_key).add(r.action);
        }
        _roleActionAccessCache.clear();
        for (const [k, v] of next) _roleActionAccessCache.set(k, v);
    } catch (e) {
        console.error('❌ loadRoleActionAccessCache failed:', e.message);
    }
}
function hasActionAccess(role, pageKey, action) {
    if (role === 'super_admin') return true;
    if (!pageKey || !action) return false;
    const pageMap = _roleActionAccessCache.get(role);
    const set = pageMap && pageMap.get(pageKey);
    return !!(set && set.has(action));
}
// Middleware factory — ใช้แทน isAdmin/isAnyAdmin/isSuperAdmin เดิมตรงๆ บน endpoint เพิ่ม/แก้ไขที่เลือกไว้
function requireAction(pageKey, action) {
    const actionLabel = action === 'add' ? 'เพิ่ม' : 'แก้ไข';
    const mw = (req, res, next) => {
        const role = req.user?.role;
        if (role && hasActionAccess(role, pageKey, action)) return next();
        res.status(403).json({ success: false, message: `ไม่มีสิทธิ์${actionLabel}ข้อมูลในหน้านี้` });
    };
    Object.defineProperty(mw, 'name', { value: `requireAction(${pageKey},${action})` }); // ชื่อสำหรับ route inventory
    return mw;
}

// === Role Groups ===
const ROLE_ADMIN_ALL = ['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'];
const ROLE_ADMIN_CENTRAL = ['admin_ssj', 'super_admin'];
const ROLE_ADMIN_LOCAL = ['admin_hos', 'admin_sso', 'admin_cup']; // admin ระดับพื้นที่
const ROLE_SCOPE_DISTRICT = ['user_cup', 'admin_cup']; // เห็นทุก hospcode ในอำเภอ
const ROLE_SCOPE_HOSPCODE = ['user', 'user_hos', 'user_sso', 'admin_hos', 'admin_sso', 'user_ssj']; // เห็นเฉพาะ hospcode ตัวเอง (รวม 'user' เดิม) — user_ssj ก็ hospcode ตัวเองเหมือนกัน (ตาราง Role System ใน CLAUDE.md)
// เห็นเฉพาะ dept ตัวเอง (ตรงข้ามกับ admin_cup/admin_hos/admin_sso ที่เห็น "ทุก dept" แม้จะมี dept_id ติดตัวอยู่ก็ตาม)
// ใช้แยกจาก ROLE_SCOPE_HOSPCODE เพราะ admin_hos/admin_sso อยู่ใน HOSPCODE (ล็อค hospcode) แต่ไม่ล็อค dept
const ROLE_SCOPE_OWN_DEPT = ['admin_ssj', 'user_ssj', 'user_hos', 'user_sso', 'user_cup', 'user'];

// Helper: ดึง distid ของ hospcode — ใช้ h.distid (pre-computed) เสมอ ไม่ CONCAT(provcode,distcode) เอง (ดู CLAUDE.md เรื่อง chospital)
const getDistrictId = async (hospcode) => {
    if (!hospcode) return null;
    const [rows] = await db.query('SELECT distid FROM chospital WHERE hoscode = ?', [hospcode]);
    return rows.length > 0 ? rows[0].distid : null;
};

// === User Permissions cache (userId → perms, TTL 60s) ===
const _userPermCache = new Map();
const USER_PERM_TTL = 60 * 1000;
// สิทธิ์ของ user — super_admin เต็มเสมอ
async function getPermsForUser(userId, role) {
    if (role === 'super_admin') return { can_edit_actual: true, can_edit_target: true };
    const now = Date.now();
    const cached = _userPermCache.get(userId);
    if (cached && cached.expiry > now) return cached.perms;
    try {
        const [rows] = await db.query('SELECT can_edit_actual, can_edit_target FROM users WHERE id = ?', [userId]);
        const r = rows[0] || {};
        const perms = {
            // ถ้า column ยังไม่มี/null → default ให้สิทธิ์เต็ม
            can_edit_actual: r.can_edit_actual === undefined || r.can_edit_actual === null ? true : !!r.can_edit_actual,
            can_edit_target: r.can_edit_target === undefined || r.can_edit_target === null ? true : !!r.can_edit_target
        };
        _userPermCache.set(userId, { perms, expiry: now + USER_PERM_TTL });
        return perms;
    } catch (e) {
        return { can_edit_actual: true, can_edit_target: true }; // fallback กัน lock
    }
}
const invalidateUserPermCache = (userId) => { if (userId) _userPermCache.delete(Number(userId)); };
// cleanup cache เป็นระยะ
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _userPermCache.entries()) if (v.expiry < now) _userPermCache.delete(k);
}, 5 * 60 * 1000);

module.exports = { PAGE_ACCESS_ROLES, PAGE_ACCESS_PAGES, PAGE_ACCESS_DEFAULT_ENABLED, loadRolePageAccessCache, hasPageAccess, PAGE_ACCESS_RULES, resolvePageKeyFromPath, ACTION_ACCESS_ROLES, ACTION_ACCESS_PAGES, ACTION_TYPES, ACTION_ACCESS_DEFAULT_ENABLED, loadRoleActionAccessCache, hasActionAccess, requireAction, ROLE_ADMIN_ALL, ROLE_ADMIN_CENTRAL, ROLE_ADMIN_LOCAL, ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId, getPermsForUser, invalidateUserPermCache };
