import { Component, inject, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { ThemeService } from '../services/theme.service';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './login.html'
})
export class LoginComponent implements OnDestroy {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  themeService = inject(ThemeService);

  showPassword: boolean = false;
  showAbout: boolean = false;
  private lastLoginPassword: string = '';

  maintenanceMode: boolean = false;
  maintenanceMessage: string = '';
  isThaIdEnabled: boolean = false;

  ssoLoading: boolean = false; // แสดง spinner ขณะรอ redirect กลับจาก ThaiD

  private statusPollTimer: any = null;

  ngOnInit() {
    this.handleSsoCallback(); // ต้องเรียกก่อน checkMaintenance เพื่อรับ sso_token ทันที
    this.checkMaintenance();
    this.ngZone.runOutsideAngular(() => {
      this.statusPollTimer = setInterval(() => {
        this.ngZone.run(() => this.checkMaintenance());
      }, 10000);
    });
  }

  ngOnDestroy() {
    if (this.statusPollTimer) { clearInterval(this.statusPollTimer); this.statusPollTimer = null; }
  }

  /** อ่าน query params จาก ThaiD callback redirect แล้วทำ login */
  private handleSsoCallback() {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('sso_token');
    const ssoUser = params.get('sso_user');
    const ssoError = params.get('sso_error');

    // เคลียร์ query string ออกจาก URL เสมอ
    if (ssoToken || ssoError) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (ssoError) {
      Swal.fire({
        icon: 'error',
        title: 'เข้าสู่ระบบผ่าน ThaiD ไม่สำเร็จ',
        text: decodeURIComponent(ssoError),
        confirmButtonColor: '#10b981'
      });
      return;
    }

    if (ssoToken && ssoUser) {
      try {
        const userInfo = JSON.parse(atob(decodeURIComponent(ssoUser)));
        this.authService.saveToken(ssoToken);
        this.authService.saveUser(userInfo);
        this.authService.startTokenExpiryWatcher();
        Swal.fire({
          icon: 'success',
          title: 'เข้าสู่ระบบสำเร็จ',
          text: `ยินดีต้อนรับ คุณ${userInfo.firstname || ''} ${userInfo.lastname || ''} (ThaiD)`,
          timer: 1500,
          showConfirmButton: false
        }).then(() => this.router.navigate(['/dashboard']));
      } catch {
        Swal.fire('ผิดพลาด', 'ไม่สามารถอ่านข้อมูล SSO ได้', 'error');
      }
    }
  }

  /** กดปุ่ม ThaiD → redirect ไป DGA */
  loginWithThaID() {
    const apiBase = environment.apiUrl.replace(/\/api\/?$/, '');
    window.location.href = `${apiBase}/auth/thaid/start`;
  }

  private checkMaintenance() {
    this.authService.getMaintenanceStatus().subscribe({
      next: (res: any) => {
        const changed = this.maintenanceMode !== !!res.maintenance
          || this.maintenanceMessage !== (res.message || '')
          || this.isThaIdEnabled !== !!res.thaid_enabled;
        this.maintenanceMode = !!res.maintenance;
        this.maintenanceMessage = res.message || '';
        this.isThaIdEnabled = !!res.thaid_enabled;
        if (changed) this.cdr.detectChanges();
      }
    });
  }

  loginForm = new FormGroup({
    username: new FormControl('', Validators.required),
    password: new FormControl('', Validators.required)
  });

  onSubmit() {
    if (this.loginForm.valid) {
      this.authService.login(this.loginForm.value).subscribe({
        next: (response) => {
          if (response.success) {
            this.authService.saveToken(response.token);
            this.authService.saveUser(response.user);

            // ถ้าต้องเปลี่ยนรหัสผ่าน (ใช้รหัสชั่วคราว / admin สั่งรีเซ็ต)
            if (response.force_change) {
              this.lastLoginPassword = this.loginForm.get('password')?.value || '';
              this.showForceChangePassword();
              return;
            }

            Swal.fire({
              icon: 'success', title: 'เข้าสู่ระบบสำเร็จ',
              text: `ยินดีต้อนรับ คุณ${response.user.firstname} ${response.user.lastname}`,
              timer: 1500, showConfirmButton: false
            }).then(() => {
              // ดึงประกาศไดนามิกจาก DB
              this.authService.getActiveAnnouncement().subscribe({
                next: (res: any) => {
                  if (res.success && res.data && Number(res.data.show_on_login) === 1) {
                    const a = res.data;
                    Swal.fire({
                      title: `<i class="fas fa-bullhorn text-red-500"></i> ${a.title || 'ประกาศระบบ'}`,
                      html: `<div class="rounded-lg p-4" style="background:${a.bg_color};color:${a.text_color}">${a.content_html}</div>`,
                      confirmButtonText: 'รับทราบ',
                      confirmButtonColor: '#16a34a'
                    }).then(() => this.router.navigate(['/dashboard']));
                  } else {
                    this.router.navigate(['/dashboard']);
                  }
                },
                error: () => this.router.navigate(['/dashboard'])
              });
            });
          }
        },
        error: (err) => {
          // 409 CONCURRENT_LOGIN — บัญชีมี session active ที่อื่นอยู่
          if (err.status === 409 && err.error?.code === 'CONCURRENT_LOGIN') {
            const ip = err.error?.last_seen_ip || '-';
            const lastSeenStr = err.error?.last_seen_at
              ? new Date(err.error.last_seen_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
              : '-';
            Swal.fire({
              icon: 'info',
              title: 'บัญชีนี้กำลังใช้งานอยู่ที่อุปกรณ์อื่น',
              html: `<div style="text-align:left;font-size:13px">
                <p class="text-gray-600">เพื่อความปลอดภัย ระบบจำกัด 1 บัญชี = 1 อุปกรณ์ในขณะเดียวกัน</p>
                <div class="mt-3 p-3 bg-sky-50 rounded-lg border border-sky-200 text-xs space-y-1">
                  <div class="font-semibold text-sky-700"><i class="fas fa-laptop mr-1"></i>เครื่องที่กำลังใช้งานอยู่:</div>
                  <div><b>IP:</b> <code>${ip}</code></div>
                  <div><b>ใช้งานล่าสุด:</b> ${lastSeenStr}</div>
                </div>
                <div class="mt-3 p-2 bg-gray-50 rounded-lg text-[11px] text-gray-600 space-y-1">
                  <div><b><i class="fas fa-clock text-gray-400 mr-1"></i>วิธีที่ 1:</b> รอประมาณ 5 นาที (session เก่าจะหมดอายุเอง)</div>
                  <div><b><i class="fas fa-arrow-right text-gray-400 mr-1"></i>วิธีที่ 2:</b> เข้าใช้ที่เครื่องนี้ทันที — เครื่องเก่าจะได้รับการแจ้งเตือนและออกจากระบบโดยสุภาพ</div>
                </div>
              </div>`,
              showCancelButton: true,
              confirmButtonText: '<i class="fas fa-sign-in-alt mr-1"></i> เข้าใช้ที่นี่',
              cancelButtonText: 'รอสักครู่',
              confirmButtonColor: '#0ea5e9',
              cancelButtonColor: '#9ca3af'
            }).then((r) => {
              if (r.isConfirmed) this.forceLogin();
            });
            return;
          }
          // 429 Rate Limit — แยกประเภทให้ user เข้าใจ
          if (err.status === 429) {
            const code = err.error?.code;
            const isIp = code === 'IP_RATE_LIMIT';
            Swal.fire({
              icon: 'warning',
              title: isIp ? 'มี Login ผิดพลาดจากเครือข่ายนี้จำนวนมาก' : 'รหัสผ่านผิดเกินกำหนด',
              html: `<div style="text-align:left;font-size:13px">
                <p class="text-gray-600">${err.error?.message || 'รอ 15 นาทีแล้วลองใหม่'}</p>
                ${isIp ? `
                  <div class="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs space-y-1">
                    <p><b><i class="fas fa-info-circle text-amber-600 mr-1"></i>เกิดจากอะไร?</b></p>
                    <ul class="ml-5 list-disc text-gray-600 space-y-0.5">
                      <li>ออฟฟิศ/หน่วยงานของคุณใช้ IP เดียวกัน หลายคน login ผิด</li>
                      <li>หรือมี script/bot พยายาม login รัวๆ</li>
                    </ul>
                    <p class="mt-2"><b>ทำยังไง:</b> รอ 15 นาที — หรือถ้าเร่งด่วน ติดต่อผู้ดูแลระบบขอ unblock</p>
                  </div>
                ` : `
                  <div class="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 text-xs">
                    <p><b><i class="fas fa-lightbulb text-blue-600 mr-1"></i>คำแนะนำ:</b></p>
                    <ul class="ml-5 list-disc text-gray-600 space-y-0.5 mt-1">
                      <li>กดปุ่ม <b>"ลืมรหัสผ่าน"</b> เพื่อรับรหัสชั่วคราว 6 หลักทาง Email</li>
                      <li>ตรวจสอบ Caps Lock + ภาษาแป้นพิมพ์ (ไทย/อังกฤษ)</li>
                    </ul>
                  </div>
                `}
              </div>`,
              confirmButtonText: 'ตกลง',
              confirmButtonColor: '#f59e0b'
            });
            return;
          }
          Swal.fire({ icon: 'error', title: 'เข้าสู่ระบบไม่สำเร็จ', text: err.error?.message || 'เกิดข้อผิดพลาด' });
        }
      });
    }
  }

  /** Force login — ใช้ตอน user ยืนยันใน 409 dialog ว่าจะ kick session เก่า */
  forceLogin() {
    const username = this.loginForm.get('username')?.value;
    const password = this.loginForm.get('password')?.value;
    if (!username || !password) {
      Swal.fire('ผิดพลาด', 'กรุณากรอก Username + Password ก่อน', 'warning');
      return;
    }
    Swal.fire({ title: 'กำลังเข้าสู่ระบบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.login({ username, password, force_login: true }).subscribe({
      next: (response: any) => {
        Swal.close();
        if (response.success) {
          this.authService.saveToken(response.token);
          this.authService.saveUser(response.user);
          Swal.fire({
            icon: 'success', title: 'เข้าสู่ระบบสำเร็จ',
            text: `ยินดีต้อนรับ คุณ${response.user.firstname} ${response.user.lastname}`,
            timer: 1500, showConfirmButton: false
          }).then(() => this.router.navigate(['/dashboard']));
        }
      },
      error: (err) => {
        Swal.close();
        Swal.fire('ผิดพลาด', err.error?.message || 'เข้าสู่ระบบไม่สำเร็จ', 'error');
      }
    });
  }

  // === ลืมรหัสผ่าน ===
  forgotPassword() {
    Swal.fire({
      title: 'ลืมรหัสผ่าน',
      html: `<p class="text-sm text-gray-600 mb-3">กรอก Username ของคุณ ระบบจะส่งรหัสชั่วคราว 6 หลักไปยัง Email ที่ลงทะเบียนไว้</p>`,
      input: 'text',
      inputLabel: 'Username',
      inputPlaceholder: 'กรอก Username ของคุณ',
      inputAttributes: { autocomplete: 'username' },
      showCancelButton: true,
      confirmButtonColor: '#2563eb',
      confirmButtonText: '<i class="fas fa-paper-plane mr-1"></i> ส่งรหัสชั่วคราว',
      cancelButtonText: 'ยกเลิก',
      inputValidator: (value) => !value ? 'กรุณากรอก Username' : null,
      showLoaderOnConfirm: true,
      preConfirm: (username) => {
        return firstValueFrom(this.authService.forgotPassword(username))
          .then((res: any) => res)
          .catch((err: any) => { Swal.showValidationMessage(err.error?.message || 'เกิดข้อผิดพลาด'); return false; });
      },
      allowOutsideClick: () => !Swal.isLoading()
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        Swal.fire({
          icon: 'success',
          title: 'ส่งรหัสชั่วคราวแล้ว',
          html: `<p class="text-sm">${result.value.message}</p>
                 <div class="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
                   <i class="fas fa-info-circle mr-1"></i>นำรหัส 6 หลักมาใส่ในช่อง Password แล้วกดเข้าสู่ระบบ<br>
                   ระบบจะบังคับให้เปลี่ยนรหัสผ่านใหม่ทันที<br>
                   <b>รหัสชั่วคราวหมดอายุใน 15 นาที</b>
                 </div>`,
          confirmButtonColor: '#16a34a',
          confirmButtonText: 'เข้าใจแล้ว'
        });
      }
    });
  }

  // === บังคับเปลี่ยนรหัสผ่าน ===
  private showForceChangePassword() {
    Swal.fire({
      title: 'กรุณาเปลี่ยนรหัสผ่านใหม่',
      html: `<p class="text-sm text-amber-700 mb-3"><i class="fas fa-exclamation-triangle mr-1"></i>คุณต้องเปลี่ยนรหัสผ่านก่อนใช้งานระบบ</p>
             <div style="position:relative">
               <input id="swal-new-pw" type="password" class="swal2-input" placeholder="รหัสผ่านใหม่ (ขั้นต่ำ 6 ตัว)" style="padding-right:40px">
               <button type="button" id="swal-toggle-pw1" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af;font-size:16px"><i class="fas fa-eye"></i></button>
             </div>
             <div style="position:relative">
               <input id="swal-confirm-pw" type="password" class="swal2-input" placeholder="ยืนยันรหัสผ่านใหม่" style="padding-right:40px">
               <button type="button" id="swal-toggle-pw2" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af;font-size:16px"><i class="fas fa-eye"></i></button>
             </div>
             <!-- Strength bar -->
             <div id="swal-strength-bar" style="margin:8px 0">
               <div style="display:flex;align-items:center;gap:8px">
                 <div style="flex:1;height:6px;background:#e5e7eb;border-radius:99px;overflow:hidden"><div id="swal-bar-fill" style="height:100%;width:0%;border-radius:99px;transition:all .3s"></div></div>
                 <span id="swal-bar-text" style="font-size:11px;font-weight:bold"></span>
               </div>
             </div>
             <!-- Checklist -->
             <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11px;text-align:left;padding:0 4px">
               <span id="chk-len" style="color:#9ca3af"><i class="fas fa-circle" style="font-size:6px;margin-right:4px"></i>6 ตัวอักษรขึ้นไป</span>
               <span id="chk-low" style="color:#9ca3af"><i class="fas fa-circle" style="font-size:6px;margin-right:4px"></i>พิมพ์เล็ก (a-z)</span>
               <span id="chk-up" style="color:#9ca3af"><i class="fas fa-circle" style="font-size:6px;margin-right:4px"></i>พิมพ์ใหญ่ (A-Z)</span>
               <span id="chk-num" style="color:#9ca3af"><i class="fas fa-circle" style="font-size:6px;margin-right:4px"></i>ตัวเลข (0-9)</span>
               <span id="chk-spc" style="color:#9ca3af;grid-column:span 2"><i class="fas fa-circle" style="font-size:6px;margin-right:4px"></i>อักขระพิเศษ (!@#$...)</span>
             </div>
             <p id="swal-match-msg" style="font-size:11px;margin-top:6px"></p>`,
      confirmButtonText: '<i class="fas fa-save mr-1"></i> เปลี่ยนรหัสผ่าน',
      confirmButtonColor: '#16a34a',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showCancelButton: false,
      didOpen: () => {
        const pw1 = document.getElementById('swal-new-pw') as HTMLInputElement;
        const pw2 = document.getElementById('swal-confirm-pw') as HTMLInputElement;
        // Toggle visibility
        document.getElementById('swal-toggle-pw1')?.addEventListener('click', () => {
          const isHidden = pw1.type === 'password';
          pw1.type = isHidden ? 'text' : 'password';
          (document.querySelector('#swal-toggle-pw1 i') as HTMLElement).className = isHidden ? 'fas fa-eye-slash' : 'fas fa-eye';
        });
        document.getElementById('swal-toggle-pw2')?.addEventListener('click', () => {
          const isHidden = pw2.type === 'password';
          pw2.type = isHidden ? 'text' : 'password';
          (document.querySelector('#swal-toggle-pw2 i') as HTMLElement).className = isHidden ? 'fas fa-eye-slash' : 'fas fa-eye';
        });
        // Strength + checklist updater
        const updateStrength = () => {
          const v = pw1.value;
          const setChk = (id: string, ok: boolean) => {
            const el = document.getElementById(id);
            if (el) { el.style.color = ok ? '#16a34a' : '#9ca3af'; el.querySelector('i')!.className = ok ? 'fas fa-check-circle' : 'fas fa-circle'; el.querySelector('i')!.style.fontSize = ok ? '10px' : '6px'; }
          };
          setChk('chk-len', v.length >= 6);
          setChk('chk-low', /[a-z]/.test(v));
          setChk('chk-up', /[A-Z]/.test(v));
          setChk('chk-num', /[0-9]/.test(v));
          setChk('chk-spc', /[^a-zA-Z0-9]/.test(v));
          let score = 0;
          if (v.length >= 6) score++; if (/[a-z]/.test(v)) score++; if (/[A-Z]/.test(v)) score++; if (/[0-9]/.test(v)) score++; if (/[^a-zA-Z0-9]/.test(v)) score++; if (v.length >= 10) score++;
          const fill = document.getElementById('swal-bar-fill') as HTMLElement;
          const text = document.getElementById('swal-bar-text') as HTMLElement;
          if (fill && text) {
            fill.style.width = (score / 6 * 100) + '%';
            if (score <= 2) { fill.style.background = '#ef4444'; text.textContent = 'อ่อน'; text.style.color = '#ef4444'; }
            else if (score <= 4) { fill.style.background = '#eab308'; text.textContent = 'ปานกลาง'; text.style.color = '#ca8a04'; }
            else { fill.style.background = '#16a34a'; text.textContent = 'แข็งแรง'; text.style.color = '#16a34a'; }
            if (!v) { fill.style.width = '0%'; text.textContent = ''; }
          }
          // Match message
          const msg = document.getElementById('swal-match-msg') as HTMLElement;
          if (msg) {
            if (pw2.value && v !== pw2.value) { msg.textContent = '✗ รหัสผ่านไม่ตรงกัน'; msg.style.color = '#dc2626'; }
            else if (pw2.value && v === pw2.value) { msg.textContent = '✓ รหัสผ่านตรงกัน'; msg.style.color = '#16a34a'; }
            else { msg.textContent = ''; }
          }
        };
        pw1.addEventListener('input', updateStrength);
        pw2.addEventListener('input', updateStrength);
      },
      preConfirm: () => {
        const newPw = (document.getElementById('swal-new-pw') as HTMLInputElement).value;
        const confirmPw = (document.getElementById('swal-confirm-pw') as HTMLInputElement).value;
        if (!newPw || newPw.length < 6) { Swal.showValidationMessage('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'); return false; }
        if (!/[a-z]/.test(newPw)) { Swal.showValidationMessage('ต้องมีตัวพิมพ์เล็ก (a-z)'); return false; }
        if (!/[A-Z]/.test(newPw)) { Swal.showValidationMessage('ต้องมีตัวพิมพ์ใหญ่ (A-Z)'); return false; }
        if (!/[0-9]/.test(newPw)) { Swal.showValidationMessage('ต้องมีตัวเลข (0-9)'); return false; }
        if (!/[^a-zA-Z0-9]/.test(newPw)) { Swal.showValidationMessage('ต้องมีอักขระพิเศษ'); return false; }
        if (newPw !== confirmPw) { Swal.showValidationMessage('รหัสผ่านไม่ตรงกัน'); return false; }
        return firstValueFrom(this.authService.changePassword(this.lastLoginPassword, newPw))
          .then((res: any) => res)
          .catch((err: any) => { Swal.showValidationMessage(err.error?.message || 'เกิดข้อผิดพลาด'); return false; });
      }
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ icon: 'success', title: 'เปลี่ยนรหัสผ่านสำเร็จ', text: 'กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่', confirmButtonColor: '#16a34a' })
          .then(() => { this.loginForm.reset(); });
      }
    });
  }
}
