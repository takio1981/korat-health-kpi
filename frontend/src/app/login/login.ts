import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './login.html'
})
export class LoginComponent {
  private router = inject(Router);
  private authService = inject(AuthService);

  showPassword: boolean = false;
  showAbout: boolean = false;
  private lastLoginPassword: string = '';

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
            }).then(() => this.router.navigate(['/charts']));
          }
        },
        error: (err) => {
          Swal.fire({ icon: 'error', title: 'เข้าสู่ระบบไม่สำเร็จ', text: err.error?.message || 'เกิดข้อผิดพลาด' });
        }
      });
    }
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