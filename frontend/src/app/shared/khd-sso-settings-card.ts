// การ์ดตั้งค่า "เข้าสู่ระบบอัตโนมัติจาก KHD" (9 พ.ย. 2569) — ฝังในหน้าตั้งค่าระบบ (super_admin)
// URL ระบบ KHD + URL หน้าเข้าสู่ระบบของ KHUPS ตั้งได้ (ผู้ใช้สั่ง: เผื่อ URL เปลี่ยนในอนาคต) | รหัสลับร่วม HS256 — แสดงครั้งเดียวตอนสร้าง
// โหลด/บันทึกผ่าน GET|PUT /auth/khd/settings เอง (ไม่รวมในปุ่มบันทึกของฟอร์มหลัก)
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

/** ตัวอย่างลิงก์ที่ KHD ต้องเปิด */
export function khdLinkExample(loginUrl: string): string {
  const base = String(loginUrl || '').trim();
  if (!base) return '';
  return base + (base.includes('?') ? '&' : '?') + 'khd_token=<JWT>';
}

/** ตรวจ URL ฝั่งหน้าจอ (ด่านจริงคือ backend — normalizeSsoUrl) */
export function isSsoUrl(value: string): boolean {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch { return false; }
}

@Component({
  selector: 'app-khd-sso-settings-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="khd-sso-settings-card">
    <h3 class="text-base font-bold text-gray-800"><i class="fas fa-right-to-bracket text-sky-600 me-1"></i>เข้าสู่ระบบอัตโนมัติจาก KHD</h3>
    <p class="text-xs text-gray-500 mt-1">ผู้ใช้ที่กดลิงก์จากระบบ KHD เข้าใช้งานได้ทันทีโดยไม่ต้องกรอกรหัสผ่าน — KHD ส่ง JWT ที่ลงนามด้วยรหัสลับร่วม (ภายในมีเฉพาะชื่อผู้ใช้ ไม่มีรหัสผ่าน)
      ชื่อผู้ใช้ต้องตรงกับบัญชีในระบบนี้ ลิงก์ไม่มี token หรือ token ไม่ถูกต้อง = ผู้ใช้เข้าสู่ระบบเองตามปกติ</p>
    <div *ngIf="loadError" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{{ loadError }}</div>
    <div *ngIf="s" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <div class="md:col-span-2 flex items-center gap-2">
        <input type="checkbox" id="khdSsoEnabled" [(ngModel)]="s.enabled" name="khdSsoEnabled" class="w-4 h-4">
        <label for="khdSsoEnabled" class="font-bold text-gray-700">เปิดใช้การเข้าสู่ระบบจาก KHD</label>
      </div>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">URL ระบบ KHD</span>
        <input type="url" [(ngModel)]="s.url" name="khdSsoUrl" id="khd-sso-url" [placeholder]="s.defaults?.url"
          class="mt-1 w-full px-3 py-2 border rounded-xl bg-white" [ngClass]="isSsoUrl(s.url) ? 'border-gray-200' : 'border-red-400'">
        <span class="text-[11px]" [ngClass]="isSsoUrl(s.url) ? 'text-gray-400' : 'text-red-600'">
          {{ isSsoUrl(s.url) ? 'ใช้ชื่อโฮสต์เป็นผู้ออก token (iss) ที่ยอมรับ: ' + issuerPreview : 'ต้องขึ้นต้นด้วย https://' }}</span>
      </label>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">URL หน้าเข้าสู่ระบบของ KHUPS KPI (ที่ KHD ต้องเปิด)</span>
        <input type="url" [(ngModel)]="s.login_url" name="khdSsoLoginUrl" id="khd-sso-login-url" [placeholder]="s.defaults?.login_url"
          class="mt-1 w-full px-3 py-2 border rounded-xl bg-white" [ngClass]="isSsoUrl(s.login_url) ? 'border-gray-200' : 'border-red-400'">
        <span class="text-[11px] text-gray-400 break-all">ลิงก์: {{ linkExample }}</span>
      </label>
      <details class="md:col-span-2 text-xs">
        <summary class="cursor-pointer font-bold text-gray-600">ขั้นสูง: issuer / audience</summary>
        <div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="block"><span class="text-gray-600">issuer (iss) — ว่าง = ชื่อโฮสต์ของ URL ระบบ KHD</span>
            <input [(ngModel)]="s.issuer" name="khdSsoIss" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white"></label>
          <label class="block"><span class="text-gray-600">audience (aud) — ว่าง = {{ s.defaults?.audience }}</span>
            <input [(ngModel)]="s.audience" name="khdSsoAud" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white"></label>
        </div>
      </details>
      <div class="md:col-span-2 text-xs text-gray-600">
        รหัสลับร่วม (HS256):
        <span *ngIf="s.has_secret" class="text-emerald-700 font-bold"><i class="fas fa-check-circle me-1"></i>ตั้งแล้ว</span>
        <span *ngIf="!s.has_secret" class="text-amber-700 font-bold"><i class="fas fa-exclamation-triangle me-1"></i>ยังไม่ได้สร้าง</span>
        · token มีอายุได้ไม่เกิน {{ (s.max_age_seconds || 300) / 60 }} นาที และใช้ได้ครั้งเดียว (jti)
      </div>
      <div *ngIf="newSecret" class="md:col-span-2 p-3 rounded-xl border border-amber-300 bg-amber-50 text-xs" id="khd-sso-new-secret">
        <div class="font-bold text-amber-800">รหัสลับใหม่ — แสดงครั้งเดียว คัดลอกส่งให้ผู้ดูแลระบบ KHD ทางช่องทางที่ปลอดภัย</div>
        <div class="mt-1 flex gap-2 items-center">
          <code class="flex-1 break-all bg-white border border-amber-200 rounded-lg px-2 py-1">{{ newSecret }}</code>
          <button type="button" (click)="copySecret()" class="px-3 py-1 rounded-lg bg-amber-600 text-white font-bold"><i class="fas fa-copy me-1"></i>คัดลอก</button>
        </div>
      </div>
    </div>
    <div *ngIf="s" class="mt-3 flex flex-wrap gap-2">
      <button type="button" (click)="save(false)" [disabled]="busy || !canSave" id="btn-khd-sso-save" class="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการตั้งค่า</button>
      <button type="button" (click)="generate()" [disabled]="busy || !canSave" id="btn-khd-sso-generate" class="px-4 py-2 rounded-xl bg-white border border-amber-300 text-amber-700 hover:bg-amber-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-key me-1"></i>{{ s.has_secret ? 'สร้างรหัสลับใหม่' : 'สร้างรหัสลับ' }}</button>
      <button type="button" (click)="resetUrls()" [disabled]="busy" class="px-4 py-2 rounded-xl bg-white border border-gray-300 hover:bg-gray-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-rotate-left me-1"></i>คืนค่า URL ตั้งต้น</button>
    </div>
  </div>`,
})
export class KhdSsoSettingsCardComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  readonly isSsoUrl = isSsoUrl;
  s: any = null;
  loadError = '';
  busy = false;
  newSecret = '';

  get canSave(): boolean { return !!this.s && isSsoUrl(this.s.url) && isSsoUrl(this.s.login_url); }
  get linkExample(): string { return khdLinkExample(this.s?.login_url); }
  get issuerPreview(): string {
    if (this.s?.issuer) return this.s.issuer;
    try { return new URL(this.s.url).hostname; } catch { return ''; }
  }

  ngOnInit() { this.load(); }

  load() {
    this.authService.apiGet('/auth/khd/settings').subscribe({
      next: (res: any) => { this.s = res?.data || null; this.cdr.detectChanges(); },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดการตั้งค่าการเข้าสู่ระบบจาก KHD ไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  resetUrls() {
    if (!this.s?.defaults) return;
    this.s.url = this.s.defaults.url;
    this.s.login_url = this.s.defaults.login_url;
  }

  generate() {
    const run = () => this.save(true);
    if (!this.s.has_secret) { run(); return; }
    Swal.fire({
      title: 'สร้างรหัสลับใหม่?', icon: 'warning',
      text: 'ลิงก์จาก KHD ที่ใช้รหัสลับเดิมจะเข้าสู่ระบบไม่ได้ทันที จนกว่าผู้ดูแลระบบ KHD จะเปลี่ยนเป็นรหัสลับใหม่',
      showCancelButton: true, confirmButtonColor: '#d97706', confirmButtonText: 'สร้างใหม่', cancelButtonText: 'ยกเลิก',
    }).then(r => { if (r.isConfirmed) run(); });
  }

  save(generateSecret: boolean) {
    this.busy = true;
    const body = { enabled: !!this.s.enabled, url: this.s.url, login_url: this.s.login_url, issuer: this.s.issuer || '', audience: this.s.audience || '', generate_secret: generateSecret };
    this.authService.apiPut('/auth/khd/settings', body).subscribe({
      next: (res: any) => {
        this.busy = false;
        this.s = res.data || this.s;
        if (res.secret) this.newSecret = res.secret;
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  copySecret() {
    navigator.clipboard?.writeText(this.newSecret).then(
      () => Swal.fire({ icon: 'success', title: 'คัดลอกแล้ว', timer: 1200, showConfirmButton: false }),
      () => Swal.fire('คัดลอกไม่สำเร็จ', 'กรุณาเลือกข้อความแล้วคัดลอกเอง', 'warning'));
  }
}
