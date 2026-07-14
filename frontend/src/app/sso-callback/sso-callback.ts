import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-sso-callback',
  standalone: true,
  imports: [],
  template: `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
                background:linear-gradient(135deg,#e8f5ee,#d1fae5,#f0fdf4)">
      <div style="text-align:center;padding:2rem">
        <svg style="width:48px;height:48px;animation:spin 1s linear infinite;color:#059669;margin:0 auto 1rem"
             fill="none" viewBox="0 0 24 24">
          <circle style="opacity:.25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path style="opacity:.75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <p style="color:#065f46;font-size:1rem;font-weight:600">กำลังเข้าสู่ระบบ...</p>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>
  `
})
export class SsoCallbackComponent implements OnInit {
  private router  = inject(Router);
  private authService = inject(AuthService);

  ngOnInit() {
    const params   = new URLSearchParams(window.location.search);
    const ssoToken = params.get('sso_token');
    const ssoUser  = params.get('sso_user');
    const ssoError = params.get('sso_error');
    const provider = params.get('sso_provider') || 'SSO';

    if (ssoError) {
      Swal.fire({
        icon: 'error',
        title: 'เข้าสู่ระบบไม่สำเร็จ',
        text: decodeURIComponent(ssoError),
        confirmButtonColor: '#10b981'
      }).then(() => this.router.navigate(['/login']));
      return;
    }

    if (ssoToken && ssoUser) {
      try {
        const userInfo = JSON.parse(atob(decodeURIComponent(ssoUser)));
        this.authService.saveToken(ssoToken);
        this.authService.saveUser(userInfo);
        this.authService.startTokenExpiryWatcher();

        const providerLabel = provider === 'thaid' ? 'ThaID'
                            : provider === 'providerid' ? 'ProviderID' : 'SSO';
        Swal.fire({
          icon: 'success',
          title: 'เข้าสู่ระบบสำเร็จ',
          html: `ยินดีต้อนรับ <b>${userInfo.firstname || ''} ${userInfo.lastname || ''}</b><br>
                 <span style="font-size:12px;color:#6b7280">(${providerLabel})</span>`,
          timer: 1500,
          showConfirmButton: false
        }).then(() => this.router.navigate(['/dashboard']));
      } catch {
        Swal.fire('ผิดพลาด', 'ไม่สามารถอ่านข้อมูล SSO ได้', 'error')
          .then(() => this.router.navigate(['/login']));
      }
      return;
    }

    // ไม่มี token และไม่มี error — redirect ไป login
    this.router.navigate(['/login']);
  }
}
