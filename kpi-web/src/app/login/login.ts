import { Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { Router } from '@angular/router'; // นำเข้า Router สำหรับเปลี่ยนหน้า
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule], // เปิดใช้งาน Reactive Forms
  templateUrl: './login.html'
})
export class LoginComponent {
  // 1. เรียกใช้งาน Router
  private router = inject(Router);
  private authService = inject(AuthService);

  // 2. สร้างโครงสร้างฟอร์ม
  loginForm = new FormGroup({
    username: new FormControl('', Validators.required),
    password: new FormControl('', Validators.required)
  });

  // 3. ฟังก์ชันนี้จะทำงานเมื่อกดปุ่ม "เข้าสู่ระบบ"
  onSubmit() {
    if (this.loginForm.valid) {
      // ยิง API ไปหา Backend
      this.authService.login(this.loginForm.value).subscribe({
        next: (response) => {
          if (response.success) {
            // บันทึก Token ที่ได้จากฐานข้อมูลจริง
            this.authService.saveToken(response.token);
            // บันทึกข้อมูลผู้ใช้
            this.authService.saveUser(response.user);
            
            Swal.fire({
              icon: 'success',
              title: 'เข้าสู่ระบบสำเร็จ',
              text: `ยินดีต้อนรับ คุณ${response.user.firstname} ${response.user.lastname} เข้าสู่ระบบ KPI Health Center`,
              timer: 1500,
              showConfirmButton: false
            }).then(() => {
              // พาไปหน้า Charts (หน้าแรกใหม่)
              this.router.navigate(['/charts']);
            });
          }
        },
        error: (err) => {
          // ถ้า username/password ผิด จะเด้งมาที่นี่
          Swal.fire({
            icon: 'error',
            title: 'เข้าสู่ระบบไม่สำเร็จ',
            text: err.error.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ'
          });
        }
      });
    }
  }
}