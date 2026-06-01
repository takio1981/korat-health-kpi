import { Injectable, inject } from '@angular/core';
import { ToastrService, ActiveToast } from 'ngx-toastr';

/**
 * ToastService — wrapper รอบ ngx-toastr ที่กำหนด theme + ใช้ง่าย
 *
 * ใช้แทน Swal.fire({ icon: 'success', timer: 1500 }) สำหรับ action ทั่วไป
 * (บันทึก / อัพเดท / ลบ / โหลด) เพื่อไม่บล็อก user
 *
 * เหลือ Swal ไว้สำหรับ:
 *   - confirm destructive (ลบถาวร / restore replace mode)
 *   - error ที่ต้อง user ตัดสินใจ
 *   - dialog ที่มี input
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private toastr = inject(ToastrService);

  /** สำเร็จ — เขียว 3 วินาที */
  success(message: string, title: string = 'สำเร็จ'): ActiveToast<any> | null {
    return this.toastr.success(message, title);
  }

  /** แจ้งข่าวสาร — น้ำเงิน 3 วินาที */
  info(message: string, title: string = ''): ActiveToast<any> | null {
    return this.toastr.info(message, title);
  }

  /** เตือน — เหลือง 4 วินาที (ยาวกว่า success เล็กน้อย เผื่ออ่าน) */
  warning(message: string, title: string = 'แจ้งเตือน'): ActiveToast<any> | null {
    return this.toastr.warning(message, title, { timeOut: 4000 });
  }

  /** ผิดพลาด — แดง 5 วินาที + sticky (ปิดเองด้วยปุ่ม X) */
  error(message: string, title: string = 'เกิดข้อผิดพลาด'): ActiveToast<any> | null {
    return this.toastr.error(message, title, { timeOut: 5000, disableTimeOut: false });
  }

  /**
   * Undo toast — ค้าง 5 วินาที + มีปุ่ม "ยกเลิก"
   * คืน promise: resolve(true) = user กดยกเลิก, resolve(false) = หมดเวลา
   *
   * ใช้ pattern: บันทึก/ลบทันที → toast.undo() → ถ้า user กดยกเลิก → revert
   * เหมาะกับ action ที่ revert ได้ เช่น approve user, soft delete
   */
  undo(message: string, undoLabel: string = 'ยกเลิก'): Promise<boolean> {
    return new Promise((resolve) => {
      const t = this.toastr.show(
        `${message} <button class="ml-2 underline font-bold">${undoLabel}</button>`,
        '',
        {
          timeOut: 5000,
          progressBar: true,
          tapToDismiss: true,
          enableHtml: true,
          toastClass: 'ngx-toastr toast-undo'
        }
      );
      let resolved = false;
      if (!t) { resolve(false); return; }
      t.onTap.subscribe(() => { if (!resolved) { resolved = true; resolve(true); } });
      t.onHidden.subscribe(() => { if (!resolved) { resolved = true; resolve(false); } });
    });
  }

  /** ปิด toast ทั้งหมด (เช่น ตอน logout) */
  clear() { this.toastr.clear(); }
}
