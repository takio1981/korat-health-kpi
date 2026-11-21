/**
 * คำแนะนำการใช้งานรายหน้าของผู้ช่วยน้องโคราชดี (ระยะที่ 2 — 19 พ.ย. 2569)
 * เนื้อหาย่อจากสคริปต์วิดีโอคู่มือ (tools/video-guide/scripts) ที่ตรวจกับหน้าจอจริงแล้ว — key = pageKey ใน app.routes.ts
 * เป้าหมายแต่ละขั้น: CSS selector และ/หรือข้อความบนปุ่ม/หัวข้อ — หาไม่เจอ (สิทธิ์นี้ไม่มีปุ่ม/ยังไม่โหลด) = ข้ามขั้นนั้น
 */
import type { PoseName } from './mascot-pose';

export interface TargetSpec {
  /** CSS selector ของตัวเลือก (ค่าตั้งต้น: ปุ่ม ลิงก์ หัวข้อ แถบ) */
  css?: string;
  /** ข้อความที่ต้องมีในตัวเลือก (ไม่สนช่องว่างซ้ำ) */
  text?: string;
  /** ข้อความต้องตรงทั้งหมด */
  exact?: boolean;
}
export interface GuideStep { text: string; target?: TargetSpec; pose?: PoseName; }
export interface GuideRole { role: string; central: boolean; admin: boolean; superAdmin: boolean; }
export interface PageGuide {
  title: string;
  intro: string | ((r: GuideRole) => string);
  /** id หัวข้อวิดีโอคู่มือ (videos/manifest.json) */
  video?: string;
  steps?: (r: GuideRole) => GuideStep[];
}

const ADMIN_ROLES = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'];
export function guideRole(role: string): GuideRole {
  return { role, central: role === 'super_admin' || role === 'admin_ssj', admin: ADMIN_ROLES.includes(role), superAdmin: role === 'super_admin' };
}

const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

export function isVisible(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.offsetParent === null && getComputedStyle(h).position !== 'fixed') return false;
  const r = h.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** หาเป้าหมายที่มองเห็นตัวแรกตามสเปก (ไอคอนภายในปุ่ม = คืนปุ่ม) */
export function findTarget(spec: TargetSpec | undefined, root: ParentNode = document): HTMLElement | null {
  if (!spec) return null;
  const css = spec.css || (spec.text ? 'button, a, h2, h3, h4, label, [role="tab"]' : '');
  if (!css) return null;
  let list: Element[];
  try { list = Array.from(root.querySelectorAll(css)); } catch { return null; }
  for (const raw of list) {
    const el = (raw.closest('button, a') && !raw.matches('button, a') && raw.matches('i, svg, span') ? raw.closest('button, a') : raw) as HTMLElement;
    if (spec.text) {
      const t = norm(el.textContent);
      if (spec.exact ? t !== norm(spec.text) : !t.includes(norm(spec.text))) continue;
    }
    if (el.closest('app-mascot-stage')) continue;
    if (isVisible(el)) return el;
  }
  return null;
}

const B = (text: string, exact = false): TargetSpec => ({ css: 'button', text, exact });

export const PAGE_GUIDES: Record<string, PageGuide> = {
  dashboard: {
    title: 'บันทึกผลงานตัวชี้วัด', video: 'dashboard',
    intro: r => r.central ? 'หน้านี้ใช้ค้นหา ตรวจสอบ และอนุมัติผลงานตัวชี้วัดของหน่วยบริการครับ' : 'หน้านี้ใช้บันทึกและติดตามผลงานตัวชี้วัดของหน่วยบริการครับ',
    steps: r => [
      { text: 'ใช้ตัวกรองด้านบนเลือกโซน อำเภอ ประเภทหน่วยบริการ หน่วยบริการ และปีงบประมาณได้ครับ', target: { css: 'select[title="ปีงบประมาณ"]' } },
      { text: 'พิมพ์คำค้น เช่น ชื่อตัวชี้วัด แล้วกด Enter ระบบจะค้นภายในขอบเขตสิทธิ์ของท่านเท่านั้น', target: { css: '#dashboard-search' } },
      ...(r.central ? [{ text: 'สิทธิ์ของท่านมีข้อมูลมาก ต้องเลือกตัวกรองอย่างน้อยหนึ่งอย่าง แล้วกดปุ่มค้นหาก่อนครับ', target: B('ค้นหา', true) }] : []),
      { text: 'ตารางแสดงเป้าหมาย ผลงานล่าสุด ร้อยละ และผลงานรายเดือนตั้งแต่ ต.ค. ถึง ก.ย. ครับ', target: { css: 'table thead' } },
      { text: 'ปุ่มดูแนวโน้ม แสดงกราฟผลงานรายเดือนของแถวนั้นครับ', target: { css: 'table button[title="ดูแนวโน้ม"]' } },
      ...(r.central
        ? [{ text: 'กดปุ่มตรวจสอบ เพื่อเลือกหลายแถวแล้วอนุมัติหรือตีกลับพร้อมกัน ผลงานที่อนุมัติแล้วจะถูกล็อกครับ', target: B('ตรวจสอบ') }]
        : [
          { text: 'กดปุ่มแก้ไขเพื่อบันทึกผลงาน พิมพ์ค่าในเดือนที่ต้องการ แล้วกดบันทึกและยืนยัน ผลงานจะรอผู้ดูแลตรวจสอบครับ', target: B('แก้ไข') },
          { text: 'ในโหมดแก้ไข ดาวน์โหลดแบบฟอร์ม Excel ไปกรอกแล้วนำเข้ากลับมาได้ ระบบจะเติมค่าให้ตรวจก่อนบันทึกครับ', target: B('แบบฟอร์ม Excel') },
        ]),
    ],
  },
  charts: {
    title: 'รายงานสถิติ', video: 'charts',
    intro: 'หน้านี้มีกราฟและสถิติ รายงานสรุปผล และตัวชี้วัดเสี่ยง ตามขอบเขตสิทธิ์ของท่านครับ',
    steps: () => [
      { text: 'แถบกราฟและสถิติ เลือกปีงบประมาณ ยุทธศาสตร์ หน่วยงาน โซน อำเภอ แล้วกราฟทั้งหน้าจะคำนวณใหม่ทันทีครับ', target: B('กราฟและสถิติ') },
      { text: 'ส่วนภาพรวมแสดงจำนวนคู่ตัวชี้วัดกับหน่วยบริการ จำนวนที่ผ่านเกณฑ์ และร้อยละผ่านเกณฑ์ครับ', target: { css: 'h2', text: 'ภาพรวม' } },
      { text: 'ตัวกรองประเภทตัวชี้วัด เลือกดูเฉพาะ R9 เขต 9 กระทรวง สสจ. ผู้ว่าฯ หรืออื่น ๆ ได้ ใช้ได้ทั้งสามแถบครับ', target: { css: '#chart-itype' } },
      { text: 'ส่วนแยกตามประเภทตัวชี้วัด สรุปร้อยละผ่านเกณฑ์ของแต่ละประเภท คลิกการ์ดเพื่อกรองประเภทนั้นได้ครับ', target: { css: '#section-itype' } },
      { text: 'แถบรายงานสรุปผล แสดงตารางรายตัวชี้วัด รายหน่วยบริการ รายอำเภอ และรายปี ส่งออกเป็น Excel ได้ครับ', target: B('รายงานสรุปผล') },
      { text: 'แถบตัวชี้วัดเสี่ยง คาดการณ์ผลงาน ณ สิ้นปีงบ และแสดงคู่ที่เสี่ยงไม่ผ่านเกณฑ์หรือขาดการรายงานครับ', target: { css: '#tab-risk' } },
    ],
  },
  notifications: {
    title: 'แจ้งเตือน', video: 'notifications',
    intro: 'หน้านี้รวมแจ้งเตือนผลการตรวจสอบ การส่งกลับแก้ไข การอุทธรณ์ และการตอบกลับครับ',
    steps: r => [
      { text: 'ไอคอนกระดิ่งด้านบนแสดงจำนวนแจ้งเตือนที่ยังไม่อ่าน กดดูได้จากทุกหน้าครับ', target: { css: 'header .fa-bell' } },
      { text: 'กรองแจ้งเตือนตามประเภท เช่น ยังไม่อ่าน อนุมัติ ตีกลับ ได้ครับ', target: B('ตีกลับ') },
      { text: 'กดอ่านทั้งหมด เพื่อเปลี่ยนทุกรายการเป็นอ่านแล้วครับ', target: B('อ่านทั้งหมด') },
      { text: r.admin ? 'ผู้ดูแลจะได้รับแจ้งเมื่อมีผลงานรอตรวจสอบหรือมีการอุทธรณ์ในขอบเขตของท่านครับ' : 'ถ้าผลงานถูกส่งกลับแก้ไข ให้ไปแก้ในหน้าบันทึกผลงานแล้วบันทึกใหม่ครับ' },
    ],
  },
  sop: {
    title: 'ผังกระบวนการ SOP', video: 'sop',
    intro: 'หน้านี้อธิบายขั้นตอนการทำงานของแต่ละระบบย่อยเป็นแผนผังครับ',
    steps: () => [
      { text: 'เลือกหัวข้อทางซ้าย ระบบจะแสดงผังขั้นตอน เช่น ตั้งแต่บันทึกผลงานจนถึงอนุมัติครับ', target: B('ระบบบันทึกผลงาน KPI') },
      { text: 'กดส่งออก PDF เพื่อเก็บผังไว้อ่านหรือพิมพ์ครับ', target: B('ส่งออก PDF') },
    ],
  },
  feedback: {
    title: 'กระดานข้อเสนอแนะ', video: 'feedback',
    intro: 'หน้านี้ใช้สอบถาม แจ้งปัญหา หรือเสนอแนะการปรับปรุงระบบครับ',
    steps: () => [
      { text: 'กดสร้างกระทู้ใหม่ เลือกประเภท กรอกหัวข้อและรายละเอียด ผู้ดูแลจะได้รับแจ้งเตือนทันทีครับ', target: B('สร้างกระทู้ใหม่') },
      { text: 'กดรายละเอียดเพื่ออ่านคำตอบหรือร่วมตอบกลับครับ', target: B('รายละเอียด') },
    ],
  },
  help: { title: 'คู่มือการใช้งาน', intro: 'หน้านี้รวมคู่มือทุกหัวข้อ พร้อมวิดีโอแนะนำตามสิทธิ์ของท่าน ถามผู้ช่วยคู่มือด้านบนได้ด้วยครับ' },
  changelog: { title: 'ประวัติการอัปเดต', intro: 'หน้านี้บอกว่าระบบมีอะไรใหม่และแก้ไขอะไรไปบ้าง เรียงจากล่าสุดครับ' },
  users: {
    title: 'จัดการผู้ใช้งาน', video: 'users',
    intro: r => r.superAdmin ? 'หน้านี้ใช้จัดการผู้ใช้ทุกคนในระบบครับ' : 'หน้านี้ใช้จัดการผู้ใช้ในขอบเขตของท่านครับ',
    steps: r => [
      { text: 'แถบสถิติผู้ใช้งาน แสดงจำนวนผู้ใช้แยกตามสิทธิ์และสถานะครับ', target: B('สถิติผู้ใช้งาน') },
      { text: 'แถบรายชื่อผู้ใช้ ค้นหาและกรองตามสิทธิ์ หน่วยบริการ หรือสถานะการอนุมัติได้ ผู้ลงทะเบียนใหม่จะรออนุมัติครับ', target: B('รายชื่อผู้ใช้') },
      { text: 'กดเพิ่มผู้ใช้งาน เพื่อสร้างบัญชีให้ผู้ใช้ครับ', target: B('เพิ่มผู้ใช้งาน') },
      { text: r.superAdmin ? 'ผู้ใช้ที่มีผลงานแล้วไม่ควรลบ ให้ปิดการใช้งานแทนครับ' : 'การลบผู้ใช้ทำได้เฉพาะผู้ดูแลระบบสูงสุด ผู้ใช้ที่มีผลงานแล้วให้ปิดการใช้งานแทนครับ' },
    ],
  },
  'kpi-manage': {
    title: 'จัดการตัวชี้วัด', video: 'kpi-manage',
    intro: 'หน้านี้ใช้จัดการตัวชี้วัด หมวดหมู่หลัก ยุทธศาสตร์ หน่วยงาน หน่วยบริการ และโซนครับ',
    steps: () => [
      { text: 'ค้นหาตัวชี้วัดตามชื่อหรือรหัส และกรองตามหมวดหมู่หลัก หน่วยงาน ปีงบประมาณ ได้ครับ', target: { css: 'input[placeholder*="ชื่อ / รหัส"]' } },
      { text: 'กดเพิ่มข้อมูลเพื่อสร้างตัวชี้วัดใหม่ ระบบสร้างรหัสตารางให้อัตโนมัติครับ', target: B('เพิ่มข้อมูล') },
      { text: 'ปุ่มเทียบกับ KHD ตรวจว่าชื่อ เกณฑ์ ประเภท และปีงบตรงกับระบบ KHD หรือไม่ครับ', target: B('เทียบกับ KHD') },
      { text: 'แถบโซน ใช้กำหนดว่าแต่ละอำเภออยู่โซนใด และตั้งชื่อโซนครับ', target: { css: '#tab-zones' } },
    ],
  },
  'kpi-setup': {
    title: 'KPI ปีงบประมาณใหม่', video: 'kpi-setup',
    intro: 'หน้านี้ใช้เพิ่มตัวชี้วัดพร้อมเป้าหมายให้หน่วยบริการก่อนเริ่มปีงบประมาณครับ',
    steps: () => [
      { text: 'เลือกปีงบประมาณ โซน อำเภอ หน่วยบริการ และหน่วยงานที่ต้องการตั้งค่าครับ', target: { css: 'select' } },
      { text: 'ปุ่มเพิ่มทุกหน่วยบริการ เพิ่มตัวชี้วัดให้ทุกหน่วยบริการตามประเภทที่ตั้งไว้ในครั้งเดียวครับ', target: B('เพิ่มทุกหน่วยบริการ') },
    ],
  },
  settings: {
    title: 'ตั้งค่าระบบ', video: 'settings',
    intro: 'หน้านี้ใช้ตั้งค่าการทำงานของทั้งระบบครับ',
    steps: () => [
      { text: 'การตั้งค่าทั่วไป กำหนดเวลาออกจากระบบอัตโนมัติ และจำนวนครั้งที่เข้าสู่ระบบผิดได้ครับ', target: { css: 'h3', text: 'การตั้งค่าทั่วไป' } },
      { text: 'ล็อกการคีย์ข้อมูล ใช้ปิดการบันทึกผลงานตามช่วงวันที่ครับ', target: { css: 'h3', text: 'ล็อคการคีย์ข้อมูล' } },
      { text: 'ส่วนผู้ช่วย AI เลือกผู้ให้บริการ รุ่นโมเดล โควตา และเปิดปิด AI รายหน้าได้ครับ', target: { css: 'h3', text: 'ผู้ช่วย AI' } },
      { text: 'ส่วนหน้าเข้าสู่ระบบ เปิดหรือปิดผมได้ทั้งระบบครับ', target: { css: 'h3', text: 'หน้าเข้าสู่ระบบ' } },
    ],
  },
  'audit-logs': {
    title: 'ประวัติการใช้งาน', video: 'audit-logs',
    intro: 'หน้านี้บันทึกทุกการเพิ่ม แก้ไข ลบ อนุมัติ และตีกลับในระบบครับ',
    steps: () => [
      { text: 'ค้นหาตามชื่อผู้ใช้หรือรายละเอียด และเลือกประเภทการกระทำได้ครับ', target: { css: 'input[placeholder*="ชื่อผู้ใช้"]' } },
      { text: 'สำรองประวัติเป็น CSV ก่อนล้างทุกครั้งนะครับ', target: B('สำรองข้อมูล (CSV)') },
    ],
  },
  'kpi-manager': {
    title: 'จัดการข้อมูล KPI', video: 'kpi-manager',
    intro: 'หน้านี้ใช้ส่งออกผลงานเป็นตารางรายตัวชี้วัด และส่งข้อมูลเข้าระบบ KHD ครับ',
    steps: () => [
      { text: 'ขั้นที่หนึ่ง เปรียบเทียบโครงสร้างตารางระหว่างระบบนี้กับ KHD ครับ', target: B('เปรียบเทียบ Structure') },
      { text: 'ตั้งตารางเวลาให้ส่งออกและส่งเข้า KHD อัตโนมัติได้ พร้อมแจ้งผลครับ', target: B('ตารางเวลา') },
    ],
  },
  announcements: { title: 'ประกาศระบบ', video: 'announcements', intro: 'หน้านี้ใช้สร้างประกาศแสดงบนหน้าเข้าสู่ระบบหรือแถบด้านบนของระบบครับ' },
  'online-users': {
    title: 'ผู้ใช้งานออนไลน์', video: 'online-users',
    intro: 'หน้านี้แสดงผู้ที่กำลังใช้งานระบบในช่วงเวลาที่เลือกครับ',
    steps: () => [{ text: 'ค้นหาตามชื่อผู้ใช้หรือหน่วยบริการ และเลือกช่วงเวลาที่ถือว่าออนไลน์ได้ครับ', target: { css: 'input[placeholder*="ค้นหา"]' } }],
  },
  'backup-manager': {
    title: 'สำรองและกู้คืนข้อมูล', video: 'backup',
    intro: 'หน้านี้ใช้สำรองและกู้คืนฐานข้อมูล รวมถึงไฟล์บน Google Drive ครับ',
    steps: () => [
      { text: 'แถบ Manual Backup ใช้สำรองทันทีครับ', target: B('Manual Backup') },
      { text: 'แถบ Files แสดงไฟล์สำรองทั้งหมด ดาวน์โหลดหรืออัปโหลดขึ้น Google Drive ได้ครับ', target: B('Files') },
    ],
  },
  'kpi-audit-digest': { title: 'แจ้งเตือนการบันทึก KPI', video: 'audit-digest', intro: 'หน้านี้ตั้งค่าสรุปการบันทึกผลงานรายวันส่งให้ผู้ดูแลครับ' },
  'error-logs': { title: 'Error Logs', video: 'error-logs', intro: 'หน้านี้แสดงข้อผิดพลาดของระบบที่บันทึกไว้ ใช้ตรวจสอบและแก้ปัญหาครับ' },
  'sso-logs': { title: 'SSO Audit Logs', intro: 'หน้านี้แสดงประวัติการเข้าสู่ระบบด้วย ThaID และ ProviderID ครับ' },
  'kpi-results-manage': { title: 'จัดการข้อมูลผลงานตัวชี้วัด', video: 'kpi-results-manage', intro: 'หน้านี้ใช้ค้นหาและลบข้อมูลผลงานรายระเบียน ควรตรวจให้แน่ใจก่อนลบทุกครั้งครับ' },
  'work-center': {
    title: 'ศูนย์งานผู้ดูแล',
    intro: 'หน้านี้สรุปงานของผู้ดูแลในหน้าเดียว ทั้งผลงานที่รอตรวจสอบ หน่วยบริการที่ยังไม่ส่งผลงาน และการส่งเข้า KHD ครับ',
    steps: r => [
      { text: 'เลือกปีงบประมาณและเดือนของผลงานที่ต้องการติดตามได้ที่มุมขวาบนครับ', target: { css: '#wc-month' } },
      { text: 'การ์ดรอตรวจสอบ และยังไม่ส่งผลงาน กดเพื่อดูรายการ แล้วกดปุ่มเปิด ระบบจะพาไปหน้าบันทึกผลงานที่กรองให้แล้วครับ', target: { css: '#wc-cards' } },
      ...(r.superAdmin ? [
        { text: 'ปุ่มส่งเตือนตอนนี้ ส่งแจ้งเตือนถึงหน่วยบริการที่ยังไม่ส่งผลงานทั้งในระบบ ไลน์ และอีเมล โดยไม่ส่งซ้ำในวันเดียวกันครับ', target: { css: '#btn-wc-remind' } },
        { text: 'ปุ่มส่งเข้า KHD เฉพาะที่เปลี่ยน ตรวจและแสดงสิ่งที่จะส่งก่อน แล้วยืนยันครั้งเดียว ย้อนกลับได้จากประวัติการส่งครับ', target: { css: '#btn-khd-quick-send' } },
      ] : []),
    ],
  },
  'role-page-access': { title: 'สิทธิ์การเข้าถึงหน้า', video: 'role-page-access', intro: 'หน้านี้ใช้เปิดปิดการเข้าถึงหน้า และสิทธิ์เพิ่มหรือแก้ไขข้อมูลของแต่ละสิทธิ์ครับ' },
};

export function guideFor(pageKey: string | null | undefined): PageGuide | null {
  return pageKey && Object.prototype.hasOwnProperty.call(PAGE_GUIDES, pageKey) ? PAGE_GUIDES[pageKey] : null;
}

export function introOf(g: PageGuide, r: GuideRole): string {
  return typeof g.intro === 'function' ? g.intro(r) : g.intro;
}
