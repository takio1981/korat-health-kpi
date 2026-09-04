import { Component, ElementRef, ViewChild, inject, ChangeDetectorRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';

// ── Types ──────────────────────────────────────────────────────────────────
interface SopNode { id: string; r: number; c: number; t: 'start'|'end'|'process'|'decision'|'db'; l: string; s?: string; }
interface SopEdge { f: string; t: string; l?: string; x?: string; n?: string; v?: string; }
interface SopSubflow { id: string; title: string; nodes: SopNode[]; edges: SopEdge[]; }
interface SopSystem {
  id: string; icon: string; title: string; sub: string; desc: string;
  actors: string[]; nodes?: SopNode[]; edges?: SopEdge[];
  subflows?: SopSubflow[]; notes?: string[];
  overview?: boolean;
  modules?: { id: string; icon: string; title: string; desc: string }[];
}

// ── SVG constants ──────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
const LW = 108; const CW = 205; const LH = 122; const NW = 162; const NH = 52; const DS = 54;

// ── Actor lane colors ──────────────────────────────────────────────────────
const ACTOR: Record<string, { fill: string; border: string; dot: string; text: string }> = {
  'ผู้ใช้งาน':         { fill:'#f0fdf4', border:'#86efac', dot:'#16a34a', text:'#15803d' },
  'ผู้ใช้ใหม่':        { fill:'#f0fdf4', border:'#86efac', dot:'#16a34a', text:'#15803d' },
  'Admin':              { fill:'#eff6ff', border:'#93c5fd', dot:'#2563eb', text:'#1d4ed8' },
  'Admin / Super Admin':{ fill:'#eef2ff', border:'#a5b4fc', dot:'#4f46e5', text:'#4338ca' },
  'Super Admin':        { fill:'#faf5ff', border:'#c4b5fd', dot:'#7c3aed', text:'#6d28d9' },
  'Backend API':        { fill:'#fff7ed', border:'#fdba74', dot:'#c2410c', text:'#9a3412' },
  'ฐานข้อมูล':         { fill:'#f8fafc', border:'#cbd5e1', dot:'#475569', text:'#334155' },
  'kpi_summary':        { fill:'#f0f9ff', border:'#7dd3fc', dot:'#0284c7', text:'#0369a1' },
  'ระบบภายนอก':        { fill:'#fff1f2', border:'#fca5a5', dot:'#b91c1c', text:'#991b1b' },
  'ข้อผิดพลาด':        { fill:'#fef2f2', border:'#fca5a5', dot:'#dc2626', text:'#b91c1c' },
};

// ── System definitions ─────────────────────────────────────────────────────
const SYSTEMS: SopSystem[] = [
{
  id:'overview', icon:'🗺️', title:'ภาพรวมระบบ', sub:'System Overview', overview: true,
  desc:'ภาพรวมความเชื่อมโยงของ 12 ระบบหลัก และทิศทางการไหลของข้อมูลระหว่างระบบ',
  actors: [],
  modules: [
    {id:'auth',    icon:'🔐', title:'ระบบ Login',      desc:'Authentication / SSO'},
    {id:'reg',     icon:'📝', title:'ลงทะเบียน',       desc:'Registration & Approval'},
    {id:'dash',    icon:'📊', title:'บันทึก KPI',      desc:'Dashboard Data Entry'},
    {id:'manage',  icon:'⚙️', title:'จัดการตัวชี้วัด', desc:'KPI Manage 5 Tabs'},
    {id:'setup',   icon:'🗓️', title:'ตั้งค่าปีงบ',     desc:'New Fiscal Year Setup'},
    {id:'charts',  icon:'📈', title:'กราฟ & รายงาน',   desc:'Charts & 4 Report Tabs'},
    {id:'users',   icon:'👥', title:'จัดการผู้ใช้',    desc:'User Management'},
    {id:'export',  icon:'💾', title:'Export & HDC',    desc:'Export + Sync HDC Wizard'},
    {id:'notif',   icon:'🔔', title:'แจ้งเตือน',       desc:'Notifications & Announcements'},
    {id:'settings',icon:'🛠️', title:'ตั้งค่าระบบ',    desc:'System Settings & SSO'},
    {id:'feedback',icon:'💬', title:'ข้อเสนอแนะ',      desc:'Feedback Board'},
    {id:'sub',     icon:'🔢', title:'ตัวชี้วัดย่อย',   desc:'Sub-indicators & AVG'},
  ],
},{
  id:'auth', icon:'🔐', title:'ระบบเข้าสู่ระบบ', sub:'Authentication',
  desc:'ยืนยันตัวตนผู้ใช้งาน 3 วิธี: Username/Password, ThaiD Direct JWT, ProviderID OAuth พร้อม Single Session Enforcement',
  actors:['ผู้ใช้งาน','Backend API','ฐานข้อมูล','ข้อผิดพลาด'],
  subflows:[
    { id:'pw', title:'Username / Password', nodes:[
      {id:'s',  r:0,c:0,t:'start',   l:'เปิดหน้า Login'},
      {id:'n1', r:0,c:1,t:'process', l:'กรอก Username + Password'},
      {id:'n2', r:1,c:1,t:'process', l:'POST /login',s:'rate-limit 15 req/15min'},
      {id:'n3', r:2,c:1,t:'db',      l:'SELECT * FROM users'},
      {id:'d1', r:1,c:2,t:'decision',l:'พบ User?'},
      {id:'d2', r:1,c:3,t:'decision',l:'อนุมัติ &\nActive?'},
      {id:'n4', r:1,c:4,t:'process', l:'bcrypt.compare(password)'},
      {id:'d3', r:1,c:5,t:'decision',l:'รหัสถูก?'},
      {id:'d4', r:1,c:6,t:'decision',l:'Session ซ้อน\n< 5 min?'},
      {id:'n5', r:1,c:7,t:'process', l:'ออก JWT (8h) + sessionId'},
      {id:'n6', r:2,c:7,t:'db',      l:'บันทึก active_session + logs'},
      {id:'ok', r:0,c:8,t:'end',     l:'→ /dashboard'},
      {id:'e1', r:3,c:2,t:'end',     l:'ไม่พบผู้ใช้\n401'},
      {id:'e2', r:3,c:3,t:'end',     l:'รอการอนุมัติ\n/ ถูกระงับ 403'},
      {id:'e3', r:3,c:5,t:'end',     l:'รหัสผ่านผิด\n401'},
      {id:'e4', r:3,c:6,t:'end',     l:'409 Concurrent\nLogin'},
    ], edges:[
      {f:'s', t:'n1'},
      {f:'n1',t:'n2',x:'bottom',n:'top',v:'vh'},
      {f:'n2',t:'n3',x:'bottom',n:'top'},
      {f:'n3',t:'d1',x:'right',n:'left',v:'hv'},
      {f:'d1',t:'d2',x:'right',n:'left',l:'ใช่'},
      {f:'d1',t:'e1',x:'bottom',n:'top',l:'ไม่'},
      {f:'d2',t:'n4',x:'right',n:'left',l:'ใช่'},
      {f:'d2',t:'e2',x:'bottom',n:'top',l:'ไม่'},
      {f:'n4',t:'d3'},
      {f:'d3',t:'d4',x:'right',n:'left',l:'ใช่'},
      {f:'d3',t:'e3',x:'bottom',n:'top',l:'ไม่'},
      {f:'d4',t:'e4',x:'bottom',n:'top',l:'ใช่'},
      {f:'d4',t:'n5',x:'right',n:'left',l:'ไม่'},
      {f:'n5',t:'n6',x:'bottom',n:'top'},
      {f:'n6',t:'ok',x:'right',n:'left',v:'hvh'},
    ]},
    { id:'thaid', title:'ThaiD Direct JWT', nodes:[
      {id:'n1', r:0,c:0,t:'start',   l:'คลิกปุ่ม ThaID'},
      {id:'n2', r:0,c:1,t:'process', l:'Redirect → thaid_login_url'},
      {id:'s',  r:3,c:0,t:'start',   l:'DGA redirect\n?token=JWT'},
      {id:'n3', r:3,c:1,t:'process', l:'ผู้ใช้สแกน QR\nยืนยัน Identity'},
      {id:'n4', r:0,c:2,t:'process', l:'handleThaidTokenParam()\ndetect ?token='},
      {id:'n5', r:1,c:2,t:'process', l:'POST /auth/thaid/verify-token'},
      {id:'n6', r:1,c:3,t:'process', l:'JWT verify (HS256)\nextract cid → SHA-256'},
      {id:'n7', r:2,c:3,t:'db',      l:'Lookup users.cid\n(dual-hash lookup)'},
      {id:'d1', r:1,c:4,t:'decision',l:'พบ User?'},
      {id:'n8', r:1,c:5,t:'process', l:'ตรวจ approved\n+ session check'},
      {id:'n9', r:1,c:6,t:'process', l:'ออก KHUPS JWT\nlog audit trail'},
      {id:'ok', r:0,c:7,t:'end',     l:'→ /dashboard'},
      {id:'e1', r:3,c:4,t:'end',     l:'reg_token → Swal\n"ลงทะเบียน?"'},
      {id:'e2', r:2,c:7,t:'end',     l:'→ /register\n?thaid_reg=token'},
    ], edges:[
      {f:'n1',t:'n2'},
      {f:'n2',t:'n4',x:'right',n:'right',v:'hv'},
      {f:'s', t:'n3'},
      {f:'n3',t:'n4',x:'top',n:'bottom',v:'hv'},
      {f:'n4',t:'n5',x:'bottom',n:'top'},
      {f:'n5',t:'n6'},
      {f:'n6',t:'n7',x:'bottom',n:'top'},
      {f:'n7',t:'d1',x:'right',n:'left',v:'hv'},
      {f:'d1',t:'n8',x:'right',n:'left',l:'ใช่'},
      {f:'d1',t:'e1',x:'bottom',n:'top',l:'ไม่พบ'},
      {f:'n8',t:'n9'},
      {f:'n9',t:'ok',x:'top',n:'bottom',v:'vh'},
      {f:'e1',t:'e2',x:'right',n:'top',v:'hv',l:'ยืนยัน'},
    ]},
    { id:'providerid', title:'ProviderID (MOPH)', nodes:[
      {id:'s',  r:0,c:0,t:'start',   l:'คลิกปุ่ม ProviderID'},
      {id:'n1', r:1,c:0,t:'process', l:'GET /auth/providerid/start'},
      {id:'n2', r:1,c:1,t:'process', l:'ตรวจ config\nสร้าง CSRF state'},
      {id:'n3', r:3,c:1,t:'process', l:'Redirect → MOPH\nAuth URL'},
      {id:'n4', r:3,c:2,t:'process', l:'ผู้ใช้ Login\nบน MOPH Portal'},
      {id:'n5', r:1,c:3,t:'process', l:'GET /auth/providerid/callback'},
      {id:'n6', r:1,c:4,t:'process', l:'Validate CSRF state\nExchange code → token'},
      {id:'n7', r:3,c:4,t:'process', l:'GET userinfo\nextract CID'},
      {id:'n8', r:2,c:5,t:'db',      l:'Lookup users.cid\nSHA-256 hash'},
      {id:'d1', r:1,c:5,t:'decision',l:'พบ User?'},
      {id:'n9', r:1,c:6,t:'process', l:'ออก JWT 8h\nlog login_logs'},
      {id:'ok', r:0,c:7,t:'end',     l:'→ /login\n?sso_token=JWT'},
      {id:'e1', r:3,c:5,t:'end',     l:'Redirect /login\n?sso_error=\nnot_registered'},
    ], edges:[
      {f:'s', t:'n1',x:'bottom',n:'top'},
      {f:'n1',t:'n2'},
      {f:'n2',t:'n3',x:'bottom',n:'top',v:'vh'},
      {f:'n3',t:'n4'},
      {f:'n4',t:'n5',x:'top',n:'bottom',v:'hv'},
      {f:'n5',t:'n6'},
      {f:'n6',t:'n7',x:'bottom',n:'top',v:'hv'},
      {f:'n7',t:'n8',x:'left',n:'bottom',v:'vh'},
      {f:'n8',t:'d1',x:'top',n:'bottom'},
      {f:'d1',t:'n9',x:'right',n:'left',l:'ใช่'},
      {f:'d1',t:'e1',x:'bottom',n:'top',l:'ไม่'},
      {f:'n9',t:'ok',x:'top',n:'bottom',v:'vh'},
    ]},
  ],
  notes:['JWT หมดอายุใน 8 ชั่วโมง | sessionId ตรวจสอบทุก request (30s cache)','Login ซ้อน > 5 นาที = 409 Concurrent Login → บังคับ logout','ThaiD token HS256 signed ด้วย thaid_client_secret ที่ตั้งไว้ใน Settings'],
},{
  id:'reg', icon:'📝', title:'ระบบลงทะเบียน', sub:'User Registration',
  desc:'สมัครใช้งาน 3 วิธี พร้อมรออนุมัติจาก Admin | CID เก็บเป็น SHA-256 hash เท่านั้น',
  actors:['ผู้ใช้ใหม่','Admin / Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิดหน้า Register'},
    {id:'d1', r:0,c:1,t:'decision',l:'วิธีลงทะเบียน?'},
    {id:'na', r:0,c:2,t:'process', l:'Manual Form\nกรอกเอง'},
    {id:'nb', r:3,c:2,t:'process', l:'ThaiD OAuth\npre-fill ชื่อ+CID'},
    {id:'nc', r:3,c:3,t:'process', l:'ProviderID OAuth\npre-fill ชื่อ+CID'},
    {id:'n1', r:0,c:3,t:'process', l:'กรอก Role + Dept\n+ Hospcode'},
    {id:'n2', r:2,c:3,t:'process', l:'POST /register'},
    {id:'n3', r:2,c:4,t:'process', l:'bcrypt.hash(pw)\nSHA-256(cid)'},
    {id:'n4', r:3,c:4,t:'db',      l:'INSERT users\nis_approved=0'},
    {id:'n5', r:1,c:4,t:'process', l:'แจ้ง Admin\n(badge + notification)'},
    {id:'d2', r:1,c:5,t:'decision',l:'Admin อนุมัติ?'},
    {id:'n6', r:1,c:6,t:'db',      l:'UPDATE is_approved=1\napproved_by=adminId'},
    {id:'n7', r:3,c:6,t:'db',      l:'UPDATE status\n= rejected'},
    {id:'ok', r:0,c:7,t:'end',     l:'→ เข้าใช้งานได้'},
    {id:'e1', r:2,c:7,t:'end',     l:'แจ้งผู้ใช้\n"ถูกปฏิเสธ"'},
  ],
  edges:[
    {f:'s', t:'d1'},
    {f:'d1',t:'na',l:'Manual'},
    {f:'d1',t:'nb',x:'bottom',n:'top',l:'ThaiD'},
    {f:'nb',t:'nc'},
    {f:'nc',t:'n1',x:'top',n:'bottom',v:'hv'},
    {f:'na',t:'n1'},
    {f:'n1',t:'n2',x:'bottom',n:'top',v:'vh'},
    {f:'n2',t:'n3'},
    {f:'n3',t:'n4',x:'bottom',n:'top'},
    {f:'n4',t:'n5',x:'left',n:'right',v:'hv'},
    {f:'n5',t:'d2'},
    {f:'d2',t:'n6',x:'right',n:'left',l:'อนุมัติ'},
    {f:'d2',t:'n7',x:'bottom',n:'top',l:'ปฏิเสธ'},
    {f:'n6',t:'ok',x:'top',n:'bottom',v:'hv'},
    {f:'n7',t:'e1',x:'top',n:'bottom',v:'hv'},
  ],
  notes:['admin_ssj สร้าง user → รอ super_admin อนุมัติ | super_admin สร้างเอง → อนุมัติทันที','CID (เลขบัตร 13 หลัก) ห้ามเก็บ plain text → SHA-256 hash เท่านั้น'],
},{
  id:'dash', icon:'📊', title:'ระบบบันทึกผลงาน KPI', sub:'Dashboard — Data Entry',
  desc:'บันทึกผลงาน 3 รูปแบบ + Approval Workflow | Focus Mode ซ่อน sidebar อัตโนมัติ',
  actors:['ผู้ใช้งาน','Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิดหน้า Dashboard'},
    {id:'n1', r:0,c:1,t:'process', l:'ตั้งค่า Filters\nปีงบ, hospcode, dept'},
    {id:'n2', r:2,c:1,t:'process', l:'GET /kpi-results\n(dept-filtered by role)'},
    {id:'n3', r:3,c:1,t:'db',      l:'kpi_results + sub_summary\n+ applySubSummary()'},
    {id:'n4', r:0,c:2,t:'process', l:'เลือก KPI\n→ กด "แก้ไข" (Focus Mode)'},
    {id:'d1', r:0,c:3,t:'decision',l:'ประเภท\nบันทึก?'},
    {id:'na', r:0,c:4,t:'process', l:'บันทึกตรง\n12 ช่องเดือน'},
    {id:'nb', r:1,c:4,t:'process', l:'Dynamic Form Modal\n6×2 Grid (12 เดือน)'},
    {id:'nc', r:2,c:4,t:'process', l:'Sub-indicator Modal\nN sub × 12 เดือน'},
    {id:'n5', r:1,c:5,t:'process', l:'POST /update-kpi\n(เฉพาะที่เปลี่ยน)'},
    {id:'n6', r:3,c:5,t:'db',      l:'kpi_results status=pending\nform_* / kpi_sub_results'},
    {id:'n7', r:1,c:6,t:'process', l:'แจ้ง Admin\n(pendingStats badge)'},
    {id:'d2', r:1,c:7,t:'decision',l:'Admin\nตรวจสอบ?'},
    {id:'ok', r:0,c:8,t:'end',     l:'status=approved\nis_locked=1'},
    {id:'e1', r:3,c:7,t:'process', l:'POST /reject-kpi\n+ comment → appeal'},
  ],
  edges:[
    {f:'s', t:'n1'},
    {f:'n1',t:'n2',x:'bottom',n:'top',v:'vh'},
    {f:'n2',t:'n3',x:'bottom',n:'top'},
    {f:'n3',t:'n4',x:'left',n:'bottom',v:'hv'},
    {f:'n4',t:'d1'},
    {f:'d1',t:'na',l:'ตรง'},
    {f:'d1',t:'nb',x:'bottom',n:'top',l:'Form'},
    {f:'d1',t:'nc',x:'bottom',n:'top',l:'Sub',v:'hv'},
    {f:'na',t:'n5'},
    {f:'nb',t:'n5',x:'right',n:'bottom',v:'hv'},
    {f:'nc',t:'n5',x:'right',n:'bottom',v:'hv'},
    {f:'n5',t:'n6',x:'bottom',n:'top',v:'vh'},
    {f:'n6',t:'n7',x:'left',n:'right',v:'hv'},
    {f:'n7',t:'d2'},
    {f:'d2',t:'ok',x:'top',n:'bottom',l:'อนุมัติ',v:'vh'},
    {f:'d2',t:'e1',x:'bottom',n:'top',l:'ปฏิเสธ'},
    {f:'e1',t:'d2',x:'top',n:'bottom',l:'re-submit',v:'hvh'},
  ],
  notes:['Focus Mode: เข้าแก้ไข → sidebar ซ่อน (focusMode$ BehaviorSubject)','admin_ssj + super_admin ไม่โหลดอัตโนมัติ ต้องกด "ค้นหา"','applySubSummaryToKpiData() early-return ถ้า isEditing=true'],
},{
  id:'manage', icon:'⚙️', title:'ระบบจัดการตัวชี้วัด', sub:'KPI Management (5 Tabs)',
  desc:'5 แท็บ: ตัวชี้วัด | หมวดหมู่ | ยุทธศาสตร์ | หน่วยงาน | หน่วยบริการ + Bulk Import + Form Builder',
  actors:['Admin / Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิด KPI Manage'},
    {id:'d1', r:0,c:1,t:'decision',l:'เลือก Tab?'},
    {id:'ta', r:0,c:2,t:'process', l:'Tab ตัวชี้วัด\n(admin_ssj+super)'},
    {id:'tb', r:2,c:2,t:'process', l:'Tab หมวดหมู่\nยุทธศาสตร์ หน่วยงาน\nหน่วยบริการ (super)'},
    {id:'tc', r:0,c:3,t:'process', l:'CRUD + Toggle\n+ Form Builder embed'},
    {id:'imp',r:1,c:3,t:'process', l:'Bulk Import Excel\nPOST /indicators/bulk-import'},
    {id:'td', r:2,c:3,t:'process', l:'CRUD + Toggle Active\n(super_admin only)'},
    {id:'n1', r:1,c:4,t:'process', l:'POST/PUT/DELETE\n/indicators'},
    {id:'d2', r:1,c:5,t:'decision',l:'Validation\nผ่าน?'},
    {id:'n2', r:1,c:6,t:'db',      l:'INSERT/UPDATE\nkpi_indicators\n+ normalizeEvalMode()'},
    {id:'ok', r:0,c:7,t:'end',     l:'อัปเดต Dashboard\n+ Filters'},
    {id:'e1', r:2,c:5,t:'end',     l:'แจ้ง Error\nข้อมูลไม่ครบ'},
  ],
  edges:[
    {f:'s', t:'d1'},
    {f:'d1',t:'ta',l:'ตัวชี้วัด'},
    {f:'d1',t:'tb',x:'bottom',n:'top',l:'อื่นๆ'},
    {f:'ta',t:'tc'},
    {f:'ta',t:'imp',x:'bottom',n:'top'},
    {f:'tb',t:'td'},
    {f:'tc',t:'n1'},
    {f:'imp',t:'n1',x:'right',n:'bottom'},
    {f:'td',t:'n1',x:'right',n:'bottom'},
    {f:'n1',t:'d2'},
    {f:'d2',t:'n2',x:'right',n:'left',l:'ผ่าน'},
    {f:'d2',t:'e1',x:'bottom',n:'top',l:'ไม่ผ่าน'},
    {f:'n2',t:'ok',x:'right',n:'bottom',v:'hv'},
  ],
  notes:['Bulk Import: แสดง แถว+คอลัมน์ที่ error ชัดเจน | import แถวถูกต้อง skip แถว error','Form Builder embed: กด clipboard icon → modal สร้าง/แก้ schema (super_admin)','evaluation_mode: any_one (บางประเภท) | all_required (บังคับทุกประเภท)'],
},{
  id:'setup', icon:'🗓️', title:'ระบบตั้งค่า KPI ปีงบใหม่', sub:'KPI Setup',
  desc:'คัดลอกตัวชี้วัดจากปีก่อน สร้าง shell records ใน kpi_results รอบันทึกข้อมูลจริง',
  actors:['Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิด KPI Setup'},
    {id:'n1', r:1,c:0,t:'process', l:'GET /kpi-setup-check\nตรวจปีที่มีอยู่แล้ว'},
    {id:'n2', r:2,c:0,t:'db',      l:'SELECT DISTINCT year_bh\nFROM kpi_results'},
    {id:'n3', r:0,c:1,t:'process', l:'เลือกปีงบ (พ.ศ.)\n+ ตัวชี้วัดที่ต้องการ'},
    {id:'n4', r:1,c:1,t:'process', l:'GET /bulk-add-kpi/preview'},
    {id:'d1', r:1,c:2,t:'decision',l:'มีข้อมูล\nซ้ำ?'},
    {id:'n5', r:1,c:3,t:'process', l:'Preview: ใหม่ N\nข้าม M รายการ'},
    {id:'n6', r:0,c:4,t:'process', l:'ยืนยัน POST\n/bulk-add-kpi'},
    {id:'n7', r:1,c:4,t:'process', l:'Batch INSERT\nkpi_results'},
    {id:'n8', r:2,c:4,t:'db',      l:'hospcode × indicator × year\n(SKIP ON DUPLICATE)'},
    {id:'ok', r:0,c:5,t:'end',     l:'N inserted\nM skipped'},
  ],
  edges:[
    {f:'s', t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'n2',x:'bottom',n:'top'},
    {f:'n2',t:'n3',x:'left',n:'bottom',v:'hv'},
    {f:'n3',t:'n4',x:'bottom',n:'top'},
    {f:'n4',t:'d1'},
    {f:'d1',t:'n5',x:'right',n:'left',l:'แสดง'},
    {f:'n5',t:'n6',x:'top',n:'bottom',v:'hv'},
    {f:'n6',t:'n7',x:'bottom',n:'top'},
    {f:'n7',t:'n8',x:'bottom',n:'top'},
    {f:'n8',t:'ok',x:'left',n:'bottom',v:'hv'},
  ],
  notes:['ปีงบประมาณ: ต.ค.(10) ถึง ก.ย.(9) | year_bh = VARCHAR(10) เช่น "2569"','Shell records: target_value จาก default, actual_value ว่าง, status=pending'],
},{
  id:'charts', icon:'📈', title:'ระบบกราฟและรายงาน', sub:'Charts & Reports',
  desc:'ดึงจาก kpi_summary materialized view เท่านั้น | Refresh summary หลัง export ใหม่',
  actors:['ผู้ใช้งาน','Backend API','kpi_summary'],
  subflows:[
    { id:'chart', title:'กราฟและสถิติ', nodes:[
      {id:'s',  r:0,c:0,t:'start',   l:'Tab กราฟและสถิติ'},
      {id:'n1', r:0,c:1,t:'process', l:'ตั้งค่า Filters\nปีงบ, ตัวชี้วัด, อำเภอ'},
      {id:'n2', r:1,c:1,t:'process', l:'GET /kpi-summary\n(role-filtered)'},
      {id:'n3', r:2,c:1,t:'db',      l:'kpi_summary\ncomposite index'},
      {id:'d1', r:1,c:2,t:'decision',l:'ข้อมูล\nทันสมัย?'},
      {id:'n4', r:1,c:3,t:'process', l:'POST /refresh-summary\n(super_admin)'},
      {id:'nr', r:2,c:3,t:'db',      l:'Batch 50 indicators\nprepare→batch→finalize'},
      {id:'n5', r:0,c:4,t:'process', l:'Render 4 Chart Types\nBar/Line/Radar/Gauge'},
      {id:'n6', r:0,c:5,t:'process', l:'Click → Drill Down\nhospcode detail'},
      {id:'ok', r:0,c:6,t:'end',     l:'กราฟ Interactive'},
    ], edges:[
      {f:'s', t:'n1'},
      {f:'n1',t:'n2',x:'bottom',n:'top'},
      {f:'n2',t:'n3',x:'bottom',n:'top'},
      {f:'n3',t:'d1',x:'left',n:'bottom',v:'hv'},
      {f:'d1',t:'n5',x:'right',n:'left',l:'ทันสมัย'},
      {f:'d1',t:'n4',x:'bottom',n:'top',l:'เก่า'},
      {f:'n4',t:'nr',x:'bottom',n:'top'},
      {f:'nr',t:'n5',x:'right',n:'bottom',v:'hv'},
      {f:'n5',t:'n6'},
      {f:'n6',t:'ok'},
    ]},
    { id:'report', title:'รายงานสรุปผล', nodes:[
      {id:'s',  r:0,c:0,t:'start',   l:'Tab รายงาน'},
      {id:'d1', r:0,c:1,t:'decision',l:'เลือก Tab\nรายงาน?'},
      {id:'r1', r:0,c:2,t:'process', l:'by-indicator\nทุก hospcode'},
      {id:'r2', r:1,c:2,t:'process', l:'by-hospital\nทุก indicator'},
      {id:'r3', r:2,c:2,t:'process', l:'by-district\naggregate'},
      {id:'r4', r:3,c:2,t:'process', l:'by-year\nเปรียบเทียบปี'},
      {id:'n1', r:1,c:3,t:'process', l:'GET /report/by-*\n(query kpi_summary)'},
      {id:'n2', r:2,c:3,t:'db',      l:'kpi_summary\ncomposite index'},
      {id:'ok', r:0,c:4,t:'end',     l:'ตาราง + Export Excel'},
    ], edges:[
      {f:'s', t:'d1'},
      {f:'d1',t:'r1',l:'Indicator'},
      {f:'d1',t:'r2',x:'bottom',n:'top',l:'Hospital'},
      {f:'d1',t:'r3',x:'bottom',n:'top',l:'District'},
      {f:'d1',t:'r4',x:'bottom',n:'top',l:'Year'},
      {f:'r1',t:'n1'},
      {f:'r2',t:'n1',x:'right',n:'bottom'},
      {f:'r3',t:'n1',x:'right',n:'bottom'},
      {f:'r4',t:'n1',x:'right',n:'bottom'},
      {f:'n1',t:'n2',x:'bottom',n:'top'},
      {f:'n2',t:'ok',x:'right',n:'bottom',v:'hv'},
    ]},
  ],
  notes:['ห้าม query kpi_results ตรง — ต้องใช้ kpi_summary เสมอ (เร็วกว่ามาก)','2 tabs ใช้ [hidden] เก็บ state ไม่ destroy component'],
},{
  id:'users', icon:'👥', title:'ระบบจัดการผู้ใช้งาน', sub:'User Management',
  desc:'CRUD ผู้ใช้งาน อนุมัติ บังคับ logout | ซิงค์กับ HDC | Force Logout ทำงานใน ~30 วินาที',
  actors:['Admin / Super Admin','Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิด User Management'},
    {id:'n1', r:2,c:0,t:'process', l:'GET /users\nincl. session info'},
    {id:'n2', r:3,c:0,t:'db',      l:'users + last_seen_at\nactive_session_id'},
    {id:'d1', r:0,c:1,t:'decision',l:'Action?'},
    {id:'aa', r:0,c:2,t:'process', l:'อนุมัติ / ปฏิเสธ\nผู้ใช้ใหม่'},
    {id:'ab', r:1,c:2,t:'process', l:'แก้ไข Role\nDept / Hospcode'},
    {id:'ac', r:2,c:2,t:'process', l:'Reset Password\n/ Toggle Active'},
    {id:'ad', r:1,c:3,t:'process', l:'Force Logout\n(super_admin)'},
    {id:'ae', r:2,c:3,t:'process', l:'Sync to HDC\n(super_admin)'},
    {id:'n3', r:0,c:3,t:'db',      l:'PUT /users/:id/approve\nis_approved=1'},
    {id:'n4', r:3,c:2,t:'process', l:'POST /admin/force-logout\nclear active_session_id'},
    {id:'n5', r:3,c:3,t:'process', l:'POST /users/sync-to-hdc\nUPSERT batch 100'},
    {id:'ok', r:0,c:4,t:'end',     l:'อัปเดตสำเร็จ'},
  ],
  edges:[
    {f:'s', t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'n2',x:'bottom',n:'top'},
    {f:'n2',t:'d1',x:'left',n:'bottom',v:'hv'},
    {f:'d1',t:'aa',l:'อนุมัติ'},
    {f:'d1',t:'ab',x:'bottom',n:'top',l:'แก้ไข'},
    {f:'d1',t:'ac',x:'bottom',n:'top',l:'Toggle'},
    {f:'d1',t:'ad',x:'right',n:'left',l:'F-Logout'},
    {f:'d1',t:'ae',x:'right',n:'left',l:'Sync'},
    {f:'aa',t:'n3'},
    {f:'ab',t:'n3',x:'right',n:'bottom'},
    {f:'ac',t:'n3',x:'right',n:'bottom'},
    {f:'ad',t:'n4',x:'bottom',n:'top'},
    {f:'ae',t:'n5',x:'bottom',n:'top'},
    {f:'n3',t:'ok'},
    {f:'n4',t:'ok',x:'top',n:'bottom',v:'hv'},
    {f:'n5',t:'ok',x:'top',n:'bottom',v:'hv'},
  ],
  notes:['Force Logout → ผู้ถูก logout จะถูกตัด session ใน ~30 วินาที (session cache TTL)','Sync users to HDC: เปรียบเทียบ 4 สถานะ matched/different/local_only/hdc_only'],
},{
  id:'export', icon:'💾', title:'ระบบ Export & Sync HDC', sub:'KPI Manager Wizard',
  desc:'Wizard 3 ขั้น: Report Compare → DB Compare → Export Tables + Sync + Scheduler อัตโนมัติ',
  actors:['Super Admin','Backend API','ฐานข้อมูล','HDC Remote DB'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิด KPI Manager'},
    {id:'w1', r:0,c:1,t:'process', l:'Step 1: Report Compare\nเทียบ local vs HDC'},
    {id:'w2', r:0,c:2,t:'process', l:'Step 2: DB Compare\nSchema + 4 operations'},
    {id:'w3', r:0,c:3,t:'process', l:'Step 3: Export\nKPI Tables'},
    {id:'n1', r:1,c:3,t:'process', l:'POST /check-kpi-export\ncheckKpiChanges()'},
    {id:'d1', r:1,c:4,t:'decision',l:'มีการ\nเปลี่ยนแปลง?'},
    {id:'n2', r:1,c:5,t:'process', l:'performKpiExport()\n3 sources merged'},
    {id:'n3', r:2,c:5,t:'db',      l:'Export tables\ncontent-based diff'},
    {id:'d2', r:1,c:6,t:'decision',l:'auto_sync\nHDC?'},
    {id:'n4', r:1,c:7,t:'process', l:'performSyncToHdc()\nINSERT ON DUPLICATE'},
    {id:'n5', r:3,c:7,t:'db',      l:'HDC Remote DB\n(ไม่ลบข้อมูลเดิม)'},
    {id:'n6', r:2,c:7,t:'process', l:'notify email\n+ Telegram'},
    {id:'ok', r:0,c:8,t:'end',     l:'Export สำเร็จ\n+ log'},
    {id:'skip',r:3,c:4,t:'end',    l:'Skip\n(ไม่มีการเปลี่ยน)'},
  ],
  edges:[
    {f:'s', t:'w1'},
    {f:'w1',t:'w2'},
    {f:'w2',t:'w3'},
    {f:'w3',t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'d1'},
    {f:'d1',t:'n2',x:'right',n:'left',l:'มี'},
    {f:'d1',t:'skip',x:'bottom',n:'top',l:'ไม่มี'},
    {f:'n2',t:'n3',x:'bottom',n:'top'},
    {f:'n3',t:'d2',x:'left',n:'bottom',v:'hv'},
    {f:'d2',t:'n4',x:'right',n:'left',l:'ใช่'},
    {f:'d2',t:'n6',x:'bottom',n:'top',l:'ไม่'},
    {f:'n4',t:'n5',x:'bottom',n:'top'},
    {f:'n5',t:'n6',x:'left',n:'right',v:'hv'},
    {f:'n6',t:'ok',x:'top',n:'bottom',v:'hv'},
  ],
  notes:['Scheduler: setInterval 30s, match 2-min window, atomic lock via UPDATE last_run_at','result = last actual value (ค่าเดือนล่าสุด) ไม่ใช่ SUM | content-based diff ไม่ใช่ timestamp'],
},{
  id:'notif', icon:'🔔', title:'ระบบแจ้งเตือนและประกาศ', sub:'Notifications & Announcements',
  desc:'การไหลของแจ้งเตือนจากเหตุการณ์ KPI | ประกาศระบบแสดง header banner ทุก session',
  actors:['ผู้ใช้งาน','Admin / Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:2,c:0,t:'start',   l:'เหตุการณ์\nในระบบ'},
    {id:'d1', r:2,c:1,t:'decision',l:'ประเภท?'},
    {id:'ea', r:1,c:2,t:'process', l:'KPI approve\nreject / appeal'},
    {id:'eb', r:2,c:2,t:'process', l:'ผู้ใช้\nลงทะเบียน'},
    {id:'ec', r:3,c:2,t:'process', l:'super_admin\nสร้างประกาศ'},
    {id:'n1', r:2,c:3,t:'process', l:'INSERT\nnotifications'},
    {id:'n2', r:3,c:3,t:'process', l:'PUT /announcements\n/:id/activate'},
    {id:'n3', r:3,c:4,t:'db',      l:'system_announcements\nis_active=1'},
    {id:'n4', r:0,c:3,t:'process', l:'GET /unread-count\n(poll layout)'},
    {id:'n5', r:0,c:4,t:'process', l:'Bell badge\nunreadCount$'},
    {id:'n6', r:0,c:5,t:'process', l:'คลิก → อ่าน\nmark-read'},
    {id:'ok', r:0,c:6,t:'end',     l:'Badge ลด\nอ่านแล้ว'},
    {id:'ok2',r:2,c:6,t:'end',     l:'Banner\nทุก session'},
  ],
  edges:[
    {f:'s', t:'d1'},
    {f:'d1',t:'ea',x:'top',n:'bottom',l:'KPI'},
    {f:'d1',t:'eb',x:'right',n:'left',l:'Register'},
    {f:'d1',t:'ec',x:'bottom',n:'top',l:'ประกาศ'},
    {f:'ea',t:'n1',x:'right',n:'top',v:'hv'},
    {f:'eb',t:'n1'},
    {f:'ec',t:'n2',x:'right',n:'left'},
    {f:'n2',t:'n3',x:'bottom',n:'top'},
    {f:'n1',t:'n4',x:'left',n:'right',v:'hv'},
    {f:'n4',t:'n5'},
    {f:'n5',t:'n6'},
    {f:'n6',t:'ok'},
    {f:'n3',t:'ok2',x:'right',n:'bottom',v:'hv'},
  ],
  notes:['unreadCount$ BehaviorSubject ใน AuthService ← layout poll ทุกครั้งที่ load','show_on_header=1 → banner ติดทุกหน้า | show_on_login=1 → แสดงบน login page'],
},{
  id:'settings', icon:'🛠️', title:'ระบบตั้งค่า', sub:'System Settings',
  desc:'General config | Maintenance Mode | SSO (ThaiD, ProviderID) | Backup | Notification channels',
  actors:['Super Admin','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'เปิด Settings'},
    {id:'n1', r:1,c:0,t:'process', l:'GET /settings\nโหลด system_settings'},
    {id:'d1', r:0,c:1,t:'decision',l:'Section?'},
    {id:'sa', r:0,c:2,t:'process', l:'General\n(name, email, Line, TG)'},
    {id:'sb', r:1,c:2,t:'process', l:'SSO Config\n(ThaiD, ProviderID)'},
    {id:'sc', r:2,c:2,t:'process', l:'Maintenance Mode\nON / OFF'},
    {id:'sd', r:0,c:3,t:'process', l:'POST /settings\nUPSERT key-value'},
    {id:'n2', r:1,c:3,t:'db',      l:'system_settings\nkey-value store'},
    {id:'te', r:2,c:3,t:'process', l:'Test email/TG/Line\n→ send test msg'},
    {id:'bk', r:0,c:4,t:'process', l:'GET /backup-database\nmysqldump'},
    {id:'ok', r:0,c:5,t:'end',     l:'บันทึกสำเร็จ'},
  ],
  edges:[
    {f:'s', t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'d1',x:'left',n:'bottom',v:'hv'},
    {f:'d1',t:'sa',l:'General'},
    {f:'d1',t:'sb',x:'bottom',n:'top',l:'SSO'},
    {f:'d1',t:'sc',x:'bottom',n:'top',l:'Maint.'},
    {f:'sa',t:'sd'},
    {f:'sb',t:'sd',x:'right',n:'bottom'},
    {f:'sc',t:'te',x:'right',n:'left'},
    {f:'sd',t:'n2',x:'bottom',n:'top'},
    {f:'n2',t:'ok',x:'right',n:'bottom',v:'hv'},
    {f:'te',t:'ok',x:'right',n:'bottom',v:'hv'},
    {f:'bk',t:'ok'},
  ],
  notes:['maintenance-status (public): login/register poll ทุก 3s','thaid_login_url: URL DGA QR สำหรับปุ่ม ThaID | client_secret: password field + show/hide'],
},{
  id:'feedback', icon:'💬', title:'ระบบข้อเสนอแนะ', sub:'Feedback System',
  desc:'กระดานข้อเสนอแนะ เข้าถึงผ่าน Profile Dropdown | thread reply | status open→in-progress→closed',
  actors:['ผู้ใช้งาน','Admin / Super Admin','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'Profile Dropdown\n→ ข้อเสนอแนะ'},
    {id:'n1', r:1,c:0,t:'process', l:'GET /feedback\nโหลดรายการ'},
    {id:'d1', r:0,c:1,t:'decision',l:'Action?'},
    {id:'pa', r:0,c:2,t:'process', l:'สร้างกระทู้\ntitle + category'},
    {id:'pb', r:1,c:2,t:'process', l:'ตอบกระทู้\n(reply thread)'},
    {id:'pc', r:2,c:2,t:'process', l:'เปลี่ยน Status\n(super_admin)'},
    {id:'n2', r:1,c:3,t:'process', l:'POST /feedback\n/ replies / status'},
    {id:'n3', r:2,c:3,t:'db',      l:'feedback_posts\nfeedback_replies'},
    {id:'ok', r:0,c:4,t:'end',     l:'อัปเดต Thread'},
  ],
  edges:[
    {f:'s', t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'d1',x:'left',n:'bottom',v:'hv'},
    {f:'d1',t:'pa',l:'สร้าง'},
    {f:'d1',t:'pb',x:'bottom',n:'top',l:'ตอบ'},
    {f:'d1',t:'pc',x:'bottom',n:'top',l:'Status'},
    {f:'pa',t:'n2'},
    {f:'pb',t:'n2',x:'right',n:'bottom'},
    {f:'pc',t:'n2',x:'right',n:'bottom'},
    {f:'n2',t:'n3',x:'bottom',n:'top'},
    {f:'n3',t:'ok',x:'right',n:'bottom',v:'hv'},
  ],
  notes:['เข้าถึงผ่าน Profile Dropdown เท่านั้น ไม่แสดงใน Sidebar','Status ต้องเป็น super_admin เท่านั้น | ปิด thread ไม่ลบข้อมูล'],
},{
  id:'sub', icon:'🔢', title:'ระบบตัวชี้วัดย่อย', sub:'Sub-Indicators',
  desc:'CRUD ตัวชี้วัดย่อย บันทึกผลรายเดือน คำนวณ AVG override หน้า Dashboard และ Export',
  actors:['Super Admin','ผู้ใช้งาน','Backend API','ฐานข้อมูล'],
  nodes:[
    {id:'s',  r:0,c:0,t:'start',   l:'KPI Manage\n→ จัดการ Sub'},
    {id:'n1', r:2,c:0,t:'process', l:'GET/POST/PUT/DELETE\n/sub-indicators'},
    {id:'n2', r:3,c:0,t:'db',      l:'kpi_sub_indicators\n(FK → kpi_indicators)'},
    {id:'n3', r:1,c:1,t:'start',   l:'Dashboard\n→ กด Sub icon'},
    {id:'n4', r:1,c:2,t:'process', l:'Modal: 12 เดือน\n× N sub (ตาราง)'},
    {id:'n5', r:2,c:2,t:'process', l:'POST /sub-results/upsert\n(UNIQUE constraint)'},
    {id:'n6', r:3,c:2,t:'db',      l:'kpi_sub_results\nsub+year+hospcode+month'},
    {id:'n7', r:2,c:3,t:'process', l:'GET /sub-results/summary\nAVG per indicator/month'},
    {id:'n8', r:1,c:3,t:'process', l:'applySubSummaryToKpiData()\noverride main row display'},
    {id:'n9', r:0,c:3,t:'process', l:'Dashboard row\nแสดง AVG target/actual'},
    {id:'ok', r:0,c:4,t:'end',     l:'Export merge\n(sub AVG → empty slots)'},
  ],
  edges:[
    {f:'s', t:'n1',x:'bottom',n:'top'},
    {f:'n1',t:'n2',x:'bottom',n:'top'},
    {f:'n3',t:'n4'},
    {f:'n4',t:'n5',x:'bottom',n:'top'},
    {f:'n5',t:'n6',x:'bottom',n:'top'},
    {f:'n6',t:'n7',x:'right',n:'bottom',v:'hv'},
    {f:'n7',t:'n8',x:'top',n:'bottom'},
    {f:'n8',t:'n9',x:'top',n:'bottom'},
    {f:'n9',t:'ok'},
    {f:'n2',t:'n4',x:'left',n:'bottom',v:'hv'},
  ],
  notes:['applySubSummaryToKpiData() early-return เมื่อ isEditing=true (ป้องกัน override ค่า user กด แก้ไข)','_mainOriginal เก็บค่าจริง | _fromSubSummary=true หมายถึงถูก override ด้วย AVG'],
}];

// ── Component ───────────────────────────────────────────────────────────────
@Component({
  selector: 'app-sop',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sop.html',
})
export class SopComponent implements AfterViewInit, OnDestroy {
  private cdr = inject(ChangeDetectorRef);
  private authService = inject(AuthService);

  systems = SYSTEMS;
  selectedSystem: SopSystem = SYSTEMS[0];
  selectedSubflow: string | null = null;
  animFrame = 0;

  @ViewChild('flowArea') flowArea!: ElementRef<HTMLDivElement>;

  ngAfterViewInit() { this.renderDiagram(); }
  ngOnDestroy() { if (this.animFrame) cancelAnimationFrame(this.animFrame); }

  selectSystem(sys: SopSystem, sfId?: string) {
    this.selectedSystem = sys;
    this.selectedSubflow = sfId || null;
    this.cdr.detectChanges();
    setTimeout(() => this.renderDiagram(), 20);
  }

  selectSubflow(sfId: string) { this.selectSystem(this.selectedSystem, sfId); }
  getSystemById(id: string): SopSystem { return SYSTEMS.find(s => s.id === id) || SYSTEMS[0]; }

  get activeSubflows() { return this.selectedSystem.subflows || []; }
  get activeSubflowId() { return this.selectedSubflow || (this.activeSubflows[0]?.id ?? null); }

  getActorStyle(actor: string): string {
    const ac = ACTOR[actor] || ACTOR['Backend API'];
    return `background:${ac.fill};border-color:${ac.border};color:${ac.text}`;
  }
  getActorDot(actor: string): string {
    return (ACTOR[actor] || ACTOR['Backend API']).dot;
  }

  // ── SVG Helpers ────────────────────────────────────────────────────────
  private mk(tag: string, attrs: Record<string, string | number>, par?: Element): SVGElement {
    const el = document.createElementNS(NS, tag) as SVGElement;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    par?.appendChild(el);
    return el;
  }

  private cx(c: number) { return LW + c * CW + CW / 2; }
  private cy(r: number) { return r * LH + LH / 2; }
  private hw(t: string) { return t === 'decision' ? DS : NW / 2; }
  private hh(t: string) { return t === 'decision' ? DS : t === 'db' ? NH / 2 + 6 : NH / 2; }

  private exitPt(nd: SopNode, side?: string): { x: number; y: number } {
    const x = this.cx(nd.c), y = this.cy(nd.r);
    const hw = this.hw(nd.t), hh = this.hh(nd.t);
    const m: Record<string, { x: number; y: number }> = {
      right: { x: x + hw, y }, left: { x: x - hw, y },
      bottom: { x, y: y + hh }, top: { x, y: y - hh }
    };
    return m[side || 'right'] ?? { x: x + hw, y };
  }
  private enterPt(nd: SopNode, side?: string): { x: number; y: number } {
    const x = this.cx(nd.c), y = this.cy(nd.r);
    const hw = this.hw(nd.t), hh = this.hh(nd.t);
    const m: Record<string, { x: number; y: number }> = {
      left: { x: x - hw, y }, right: { x: x + hw, y },
      top: { x, y: y - hh }, bottom: { x, y: y + hh }
    };
    return m[side || 'left'] ?? { x: x - hw, y };
  }

  private routePath(fp: { x: number; y: number }, tp: { x: number; y: number }, via?: string): string {
    const s = (v: number) => Math.round(v * 10) / 10;
    if (via === 'hv') return `M${s(fp.x)},${s(fp.y)} L${s(tp.x)},${s(fp.y)} L${s(tp.x)},${s(tp.y)}`;
    if (via === 'vh') return `M${s(fp.x)},${s(fp.y)} L${s(fp.x)},${s(tp.y)} L${s(tp.x)},${s(tp.y)}`;
    if (via === 'hvh') {
      const mx = s((fp.x + tp.x) / 2);
      return `M${s(fp.x)},${s(fp.y)} L${mx},${s(fp.y)} L${mx},${s(tp.y)} L${s(tp.x)},${s(tp.y)}`;
    }
    const dx = tp.x - fp.x, dy = tp.y - fp.y;
    if (Math.abs(dx) < 3 || Math.abs(dy) < 3) return `M${s(fp.x)},${s(fp.y)} L${s(tp.x)},${s(tp.y)}`;
    if (Math.abs(dx) >= Math.abs(dy)) return `M${s(fp.x)},${s(fp.y)} L${s(tp.x)},${s(fp.y)} L${s(tp.x)},${s(tp.y)}`;
    return `M${s(fp.x)},${s(fp.y)} L${s(fp.x)},${s(tp.y)} L${s(tp.x)},${s(tp.y)}`;
  }

  private shorten(fp: { x: number; y: number }, tp: { x: number; y: number }, d = 9) {
    const dx = tp.x - fp.x, dy = tp.y - fp.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < d) return tp;
    return { x: tp.x - dx / len * d, y: tp.y - dy / len * d };
  }

  // ── Main renderer ──────────────────────────────────────────────────────
  renderDiagram() {
    const wrap = this.flowArea?.nativeElement;
    if (!wrap) return;
    wrap.innerHTML = '';

    const sys = this.selectedSystem;
    if (sys.overview) { this.renderOverview(wrap, sys); return; }

    const sfId = this.activeSubflowId;
    const flow = sys.subflows ? (sys.subflows.find(s => s.id === sfId) || sys.subflows[0]) : sys;
    const nodes: SopNode[] = flow.nodes || [];
    const edges: SopEdge[] = flow.edges || [];

    const numCols = nodes.length ? Math.max(...nodes.map(n => n.c)) + 1 : 4;
    const numRows = sys.actors.length || 2;
    const svgW = LW + numCols * CW + 40;
    const svgH = numRows * LH + 4;

    const outer = document.createElement('div');
    outer.style.cssText = 'overflow-x:auto;border-radius:12px 12px 0 0;';
    wrap.appendChild(outer);

    const svg = this.mk('svg', { width: svgW, height: svgH, viewBox: `0 0 ${svgW} ${svgH}` }) as SVGSVGElement;

    // CSS animations injected into SVG
    const style = document.createElementNS(NS, 'style');
    style.textContent = `
      .fe { stroke-dasharray:10 6; animation: fd 1.6s linear infinite; }
      @keyframes fd { to { stroke-dashoffset:-32; } }
      .ns { animation: ni 0.45s cubic-bezier(.2,1.1,.4,1) both; }
      @keyframes ni { from{opacity:0;transform:scale(0.65) translate(0,10px)} to{opacity:1;transform:scale(1) translate(0,0)} }
      .gS { animation: gP 2.8s ease-in-out infinite; }
      @keyframes gP { 0%,100%{filter:drop-shadow(0 0 4px rgba(15,124,84,.45))} 50%{filter:drop-shadow(0 0 14px rgba(45,181,115,.9))} }
      .gE { animation: gR 2.8s ease-in-out infinite; }
      @keyframes gR { 0%,100%{filter:drop-shadow(0 0 4px rgba(220,38,38,.4))} 50%{filter:drop-shadow(0 0 12px rgba(239,68,68,.85))} }
      .dot { animation: dotO 0.3s ease-in both; }
      @keyframes dotO { from{opacity:0} to{opacity:0.85} }
    `;
    svg.appendChild(style);

    // Defs
    const defs = this.mk('defs', {}, svg);
    // Arrowhead
    const arr = this.mk('marker', { id: 'arr', markerWidth: 9, markerHeight: 7, refX: 8, refY: 3.5, orient: 'auto' }, defs);
    this.mk('path', { d: 'M0,0 L0,7 L9,3.5z', fill: '#94a3b8' }, arr);
    // Drop shadow filter
    const flt = this.mk('filter', { id: 'sh', x: '-12%', y: '-20%', width: '124%', height: '140%' }, defs);
    this.mk('feDropShadow', { dx: 0, dy: 2, stdDeviation: 2.5, 'flood-opacity': 0.1 }, flt);
    // Lane gradients
    sys.actors.forEach((actor, i) => {
      const ac = ACTOR[actor] || ACTOR['Backend API'];
      const grad = this.mk('linearGradient', { id: `lg${i}`, x1: '0', y1: '0', x2: '1', y2: '0' }, defs);
      this.mk('stop', { offset: '0%', 'stop-color': ac.fill, 'stop-opacity': '1' }, grad);
      this.mk('stop', { offset: '100%', 'stop-color': ac.fill, 'stop-opacity': '0.45' }, grad);
    });

    // Label column bg
    this.mk('rect', { x: 0, y: 0, width: LW, height: svgH, fill: '#f8fafc' }, svg);

    // Lane bands
    sys.actors.forEach((actor, i) => {
      const ac = ACTOR[actor] || ACTOR['Backend API'];
      this.mk('rect', { x: LW, y: i * LH, width: svgW - LW, height: LH, fill: `url(#lg${i})` }, svg);
      this.mk('line', { x1: 0, y1: i * LH, x2: svgW, y2: i * LH, stroke: '#e2e8f0', 'stroke-width': 1 }, svg);
      // Label background pill
      this.mk('rect', { x: 4, y: i * LH + LH / 2 - 32, width: LW - 8, height: 64, rx: 8, fill: ac.fill, stroke: ac.border, 'stroke-width': 1 }, svg);
      // Dot indicator
      this.mk('circle', { cx: LW / 2, cy: i * LH + 16, r: 5, fill: ac.dot }, svg);
      // Lane label (horizontal, multi-line if needed)
      const lines = actor.split('/').map(s => s.trim());
      lines.forEach((line, li) => {
        this.mk('text', {
          x: LW / 2, y: i * LH + LH / 2 - 4 + li * 14,
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-family': "'IBM Plex Sans Thai','Sarabun',sans-serif",
          'font-size': 10, 'font-weight': 600, fill: ac.text
        }, svg).textContent = line;
      });
    });
    // Bottom border
    this.mk('line', { x1: 0, y1: numRows * LH, x2: svgW, y2: numRows * LH, stroke: '#e2e8f0', 'stroke-width': 1 }, svg);
    this.mk('line', { x1: LW, y1: 0, x2: LW, y2: svgH, stroke: '#cbd5e1', 'stroke-width': 1.5 }, svg);

    const ndMap: Record<string, SopNode> = Object.fromEntries(nodes.map(n => [n.id, n]));

    // Draw edges
    edges.forEach((edge, ei) => {
      const fn = ndMap[edge.f], tn = ndMap[edge.t];
      if (!fn || !tn) return;
      const fp = this.exitPt(fn, edge.x);
      const tp = this.enterPt(tn, edge.n);
      const tpS = this.shorten(fp, tp);
      const pathD = this.routePath(fp, tpS, edge.v);
      const fullD = this.routePath(fp, tp, edge.v);  // for dot

      // Edge path (animated dashes)
      const pathId = `ep${ei}`;
      this.mk('path', {
        id: pathId, d: pathD, fill: 'none',
        stroke: '#94a3b8', 'stroke-width': 1.7, 'marker-end': 'url(#arr)',
        class: 'fe', 'stroke-dasharray': '10 6'
      }, svg);

      // Moving data dot
      const dot = this.mk('circle', { r: 3.8, fill: '#2db573', opacity: 0, class: 'dot' }, svg);
      const anim = this.mk('animateMotion', {
        dur: `${1.5 + ei * 0.08}s`, repeatCount: 'indefinite', path: fullD, calcMode: 'linear'
      }, dot);
      dot.appendChild(anim);

      // Edge label
      if (edge.l) {
        const pts = fullD.match(/-?\d+\.?\d*/g)!.map(Number);
        const mx = (pts[0] + pts[pts.length - 2]) / 2;
        const my = (pts[1] + pts[pts.length - 1]) / 2;
        this.mk('rect', { x: mx - 20, y: my - 9, width: 40, height: 18, rx: 5, fill: 'white', opacity: 0.93, stroke: '#e2e8f0', 'stroke-width': 1 }, svg);
        const lt = this.mk('text', {
          x: mx, y: my + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-family': "'IBM Plex Sans Thai','Sarabun',sans-serif", 'font-size': 10, 'font-weight': 700, fill: '#475569'
        }, svg);
        lt.textContent = edge.l;
      }
    });

    // Draw nodes
    nodes.forEach((nd, ni) => {
      const x = this.cx(nd.c), y = this.cy(nd.r);
      const delay = `${ni * 0.04}s`;
      if (nd.t === 'start') this.drawOval(svg, x, y, nd.l, false, delay);
      else if (nd.t === 'end') this.drawOval(svg, x, y, nd.l, true, delay);
      else if (nd.t === 'process') this.drawProcess(svg, x, y, nd.l, nd.s, delay);
      else if (nd.t === 'decision') this.drawDecision(svg, x, y, nd.l, delay);
      else if (nd.t === 'db') this.drawDB(svg, x, y, nd.l, nd.s, delay);
    });

    outer.appendChild(svg);

    // Notes
    if (sys.notes?.length) {
      const nd = document.createElement('div');
      nd.className = 'flex flex-wrap gap-x-5 gap-y-1 px-4 py-3 border-t border-gray-100 bg-gray-50 rounded-b-xl';
      sys.notes.forEach(note => {
        const p = document.createElement('div');
        p.className = 'flex items-start gap-1.5 text-[11.5px] text-gray-500';
        p.innerHTML = `<span class="text-green-600 mt-0.5">▸</span><span>${note}</span>`;
        nd.appendChild(p);
      });
      wrap.appendChild(nd);
    }
  }

  // ── Shape drawing ───────────────────────────────────────────────────────
  private drawOval(svg: Element, x: number, y: number, label: string, isEnd: boolean, delay: string) {
    const W = NW * 0.85, H = NH;
    const fill = isEnd ? '#dc2626' : '#0f7c54';
    const cls = isEnd ? 'gE ns' : 'gS ns';
    const g = this.mk('g', { class: cls, style: `animation-delay:${delay}` }, svg);
    this.mk('ellipse', { cx: x, cy: y, rx: W / 2, ry: H / 2, fill }, g);
    if (isEnd) this.mk('ellipse', { cx: x, cy: y, rx: W / 2 - 3, ry: H / 2 - 3, fill: 'none', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 1.5 }, g);
    this.addMultilineText(g, x, y, label, { fill: 'white', 'font-size': 10.5, 'font-weight': 700 });
  }

  private drawProcess(svg: Element, x: number, y: number, label: string, sub: string | undefined, delay: string) {
    const g = this.mk('g', { class: 'ns', style: `animation-delay:${delay}`, filter: 'url(#sh)' }, svg);
    this.mk('rect', { x: x - NW / 2, y: y - NH / 2, width: NW, height: NH, rx: 9, ry: 9, fill: 'white', stroke: '#cbd5e1', 'stroke-width': 1.5 }, g);
    // Accent top strip
    this.mk('rect', { x: x - NW / 2 + 1, y: y - NH / 2 + 1, width: NW - 2, height: 3, rx: 2, fill: '#0f7c54', opacity: 0.3 }, g);
    this.addMultilineText(g, x, y - (sub ? 6 : 0), label, { fill: '#1e293b', 'font-size': 11, 'font-weight': 500 });
    if (sub) {
      this.addMultilineText(g, x, y + 11, sub, {
        fill: '#64748b', 'font-size': 9.5, 'font-family': "'JetBrains Mono',monospace"
      });
    }
  }

  private drawDecision(svg: Element, x: number, y: number, label: string, delay: string) {
    const g = this.mk('g', { class: 'ns', style: `animation-delay:${delay}`, filter: 'url(#sh)' }, svg);
    const S = DS;
    this.mk('path', { d: `M${x},${y - S} L${x + S},${y} L${x},${y + S} L${x - S},${y}Z`, fill: '#fef3c7', stroke: '#d97706', 'stroke-width': 2 }, g);
    // Inner accent
    this.mk('path', { d: `M${x},${y - S + 5} L${x + S - 5},${y} L${x},${y + S - 5} L${x - S + 5},${y}Z`, fill: 'none', stroke: '#f59e0b', 'stroke-width': 0.5, opacity: 0.6 }, g);
    this.addMultilineText(g, x, y, label, { fill: '#92400e', 'font-size': 10.5, 'font-weight': 700 });
  }

  private drawDB(svg: Element, x: number, y: number, label: string, sub: string | undefined, delay: string) {
    const W = NW, H = NH, ry = 10;
    const g = this.mk('g', { class: 'ns', style: `animation-delay:${delay}`, filter: 'url(#sh)' }, svg);
    this.mk('rect', { x: x - W / 2, y: y - H / 2 + ry, width: W, height: H - ry, fill: '#f1f5f9', stroke: '#94a3b8', 'stroke-width': 1.5 }, g);
    this.mk('ellipse', { cx: x, cy: y - H / 2 + ry, rx: W / 2, ry, fill: '#e2e8f0', stroke: '#94a3b8', 'stroke-width': 1.5 }, g);
    this.mk('ellipse', { cx: x, cy: y + H / 2, rx: W / 2, ry: 5, fill: '#f1f5f9', stroke: '#94a3b8', 'stroke-width': 1.5 }, g);
    this.mk('line', { x1: x - W / 2, y1: y - H / 2 + ry, x2: x - W / 2, y2: y + H / 2, stroke: '#94a3b8', 'stroke-width': 1.5 }, g);
    this.mk('line', { x1: x + W / 2, y1: y - H / 2 + ry, x2: x + W / 2, y2: y + H / 2, stroke: '#94a3b8', 'stroke-width': 1.5 }, g);
    this.addMultilineText(g, x, y - (sub ? 6 : 0) + 4, label, {
      fill: '#334155', 'font-size': 10.5, 'font-family': "'JetBrains Mono',monospace"
    });
    if (sub) this.addMultilineText(g, x, y + 12, sub, { fill: '#64748b', 'font-size': 9 });
  }

  private addMultilineText(parent: Element, x: number, y: number, label: string, attrs: Record<string, string | number>) {
    const lines = label.split('\n');
    const base = y - (lines.length - 1) * 7;
    lines.forEach((line, i) => {
      const t = this.mk('text', {
        x, y: base + i * 14,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-family': "'IBM Plex Sans Thai','Sarabun',sans-serif",
        ...attrs
      }, parent);
      t.textContent = line;
    });
  }

  // ── Overview renderer ────────────────────────────────────────────────────
  private renderOverview(wrap: HTMLElement, sys: SopSystem) {
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 p-4';
    (sys.modules || []).forEach(m => {
      const card = document.createElement('div');
      card.className = 'bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-green-400 hover:shadow-md transition-all hover:-translate-y-0.5';
      card.innerHTML = `<div class="text-2xl mb-2">${m.icon}</div><div class="text-sm font-semibold text-gray-800 font-[IBM_Plex_Sans_Thai]">${m.title}</div><div class="text-[11px] text-gray-400 mt-1 leading-snug">${m.desc}</div>`;
      card.onclick = () => {
        const target = SYSTEMS.find(s => s.id === m.id);
        if (target) this.selectSystem(target);
      };
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    // Connection map
    const dep = document.createElement('div');
    dep.className = 'mx-4 mb-4 bg-gray-50 border border-gray-200 rounded-xl p-4';
    dep.innerHTML = `<div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">การเชื่อมโยงระหว่างระบบ</div>`;
    const rows: [string, string][] = [
      ['🔐 Auth', 'รับ SSO config จาก Settings | ส่ง JWT session ให้ทุกระบบ'],
      ['📝 Register', 'ส่ง pending user → User Management รออนุมัติ'],
      ['📊 Dashboard', 'ส่ง kpi_results → kpi_summary → Charts | รับ indicators จาก KPI Manage'],
      ['📈 Charts', 'ดึงจาก kpi_summary เท่านั้น (refresh โดย Export step 3)'],
      ['💾 Export', 'Export tables → HDC | Refresh kpi_summary → Charts ทันสมัย'],
      ['🔢 Sub-indicators', 'AVG → override Dashboard main row | merge → Export (empty slots)'],
      ['🛠️ Settings', 'SSO config → Auth | Notify config → Export Scheduler'],
    ];
    rows.forEach(([badge, txt]) => {
      const r = document.createElement('div');
      r.className = 'flex items-start gap-2 mb-2 text-[12px]';
      r.innerHTML = `<span class="bg-green-100 text-green-700 rounded px-2 py-0.5 text-[10px] font-bold whitespace-nowrap">${badge}</span><span class="text-gray-600 leading-5">${txt}</span>`;
      dep.appendChild(r);
    });
    wrap.appendChild(dep);
  }

  // ── Symbol legend ────────────────────────────────────────────────────────
  readonly symbols = [
    { label: 'เริ่มต้น / สิ้นสุด', color: '#0f7c54', shape: 'oval' },
    { label: 'กระบวนการ (Process)', color: '#3b82f6', shape: 'rect' },
    { label: 'การตัดสินใจ', color: '#d97706', shape: 'diamond' },
    { label: 'ฐานข้อมูล', color: '#64748b', shape: 'db' },
    { label: 'ข้อมูลไหล + dot = realtime flow', color: '#2db573', shape: 'arrow' },
  ];
}
