import { Injectable } from '@angular/core';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// Export หน้าเว็บเป็น PDF โดย capture DOM element เป็นรูปภาพ (html2canvas) แล้วฝังใน PDF (jsPDF)
// เลือกวิธีนี้แทนการวาดข้อความ Thai ตรงๆ ด้วย jsPDF เพราะ jsPDF ไม่รองรับฟอนต์ไทยในตัว
// (ต้อง embed ฟอนต์เพิ่ม) — capture เป็นภาพใช้ฟอนต์ Sarabun ที่ browser render จริงอยู่แล้ว
// ไม่ต้อง embed ฟอนต์เอง แลกกับไฟล์ใหญ่กว่าและ copy ข้อความไม่ได้ (ยอมรับได้ตามที่ตกลงกับผู้ใช้)
@Injectable({ providedIn: 'root' })
export class PdfExportService {
  private readonly PAGE_WIDTH_MM = 210;  // A4 portrait
  private readonly PAGE_HEIGHT_MM = 297;
  private readonly MARGIN_MM = 10;

  createDoc(): jsPDF {
    return new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  }

  /** รอฟอนต์ (Sarabun, Font Awesome) โหลดเสร็จก่อน capture ครั้งแรก กันตัวอักษร/ไอคอนหายหรือใช้ฟอนต์สำรอง */
  async waitFontsReady(): Promise<void> {
    try { await (document as any).fonts?.ready; } catch { /* browser เก่าไม่รองรับ document.fonts — ข้าม */ }
  }

  /**
   * Capture element เดียว แล้วเพิ่มเข้า doc เป็น 1 หน้าหรือหลายหน้า (ตัดแบ่งถ้าสูงเกิน 1 หน้า A4)
   * @param isFirstElement true เฉพาะ element แรกสุดของการ export ทั้งหมด — ใช้หน้าแรกที่ jsPDF สร้างมาให้ ไม่ addPage ซ้ำ
   *
   * ใช้ JPEG (ไม่ใช่ PNG) + scale 1.5 — PNG แบบ lossless ที่ scale 2 ทำให้ไฟล์ใหญ่เกินจริง
   * (ทดสอบแล้ว SOP 18 หน้า ได้ไฟล์ 120MB+ ด้วย PNG scale 2) JPEG คุณภาพ 0.85 อ่านง่ายเท่าเดิม
   * แต่ไฟล์เล็กลงมาก เหมาะกับเนื้อหา UI สีพื้น/ตัวอักษรมากกว่ารูปถ่าย
   */
  async addElementAsPages(doc: jsPDF, element: HTMLElement, isFirstElement: boolean, scale = 1.5): Promise<void> {
    const canvas = await html2canvas(element, {
      scale,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });

    const usableWidthMm = this.PAGE_WIDTH_MM - this.MARGIN_MM * 2;
    const usableHeightMm = this.PAGE_HEIGHT_MM - this.MARGIN_MM * 2;
    const pxPerMm = canvas.width / usableWidthMm;
    const pageHeightPx = Math.max(1, Math.floor(usableHeightMm * pxPerMm));

    // ถ้า canvas สูง 0 (capture ผิดพลาด/element ยังไม่พร้อม) ข้ามไปเลย กัน element ถัดไปพังตาม
    if (canvas.width === 0 || canvas.height === 0) return;

    let renderedPx = 0;
    let pageIndex = 0;
    while (renderedPx < canvas.height) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedPx);

      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      const ctx = sliceCanvas.getContext('2d')!;
      // พื้นขาวก่อนวาดทับ กัน JPEG (ไม่รองรับ alpha) เอาพื้นโปร่งใสมาเป็นสีดำ
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      ctx.drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);

      const imgData = sliceCanvas.toDataURL('image/jpeg', 0.85);
      if (!(isFirstElement && pageIndex === 0)) doc.addPage();
      const sliceHeightMm = sliceHeightPx / pxPerMm;
      doc.addImage(imgData, 'JPEG', this.MARGIN_MM, this.MARGIN_MM, usableWidthMm, sliceHeightMm);

      renderedPx += sliceHeightPx;
      pageIndex++;
    }
  }

  save(doc: jsPDF, filename: string): void {
    doc.save(filename);
  }
}
