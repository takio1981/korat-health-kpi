// การ์ดตั้งค่า "เสียงพูดน้องคิดดี (Gemini TTS)" (26 พ.ย. 2569) — ฝังในหน้าตั้งค่าระบบ (super_admin)
// เสียงแบบสดใช้อ่านข้อความที่ไม่มีไฟล์เสียงสร้างล่วงหน้า (เช่น คำตอบ AI) — โหลด/บันทึกผ่าน /tts/settings เอง, ลองฟังผ่าน /tts/test
// คีย์ว่าง = ใช้คีย์ของผู้ช่วย AI เมื่อผู้ช่วย AI ตั้งเป็น Google Gemini อยู่แล้ว | ไม่แสดงคีย์ที่บันทึกไว้
import { Component, OnDestroy, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

export interface TtsVoice { name: string; trait: string; gender: 'm' | 'f'; }

const TRAIT_TH: Record<string, string> = {
  Upbeat: 'สดใส', Friendly: 'เป็นกันเอง', Lively: 'มีชีวิตชีวา', Casual: 'สบาย ๆ', Excitable: 'ตื่นเต้น', Clear: 'ชัดเจน', 'Easy-going': 'ผ่อนคลาย',
  Smooth: 'นุ่มนวล', Informative: 'ให้ข้อมูล', Firm: 'หนักแน่น', Breathy: 'มีลมหายใจ', Gravelly: 'แหบเล็กน้อย', Even: 'เรียบ', Knowledgeable: 'รอบรู้',
  Bright: 'สว่าง', Youthful: 'อ่อนเยาว์', Breezy: 'สบายใจ', Soft: 'นุ่ม', Mature: 'เป็นผู้ใหญ่', Forward: 'ตรงไปตรงมา', Gentle: 'อ่อนโยน', Warm: 'อบอุ่น',
};
/** ป้ายตัวเลือกเสียง เช่น "Puck — สดใส (ชาย)" */
export function voiceLabel(v: TtsVoice): string {
  return `${v.name} — ${TRAIT_TH[v.trait] || v.trait} (${v.gender === 'f' ? 'หญิง' : 'ชาย'})`;
}
/** ที่มาของคีย์ */
export function keySourceText(src: string): string {
  return src === 'own' ? 'ใช้คีย์ที่ตั้งไว้สำหรับเสียงพูด' : src === 'ai' ? 'ใช้คีย์ของผู้ช่วย AI (Google Gemini)' : 'ยังไม่มีคีย์ — เสียงแบบสดใช้ไม่ได้ (ใช้เสียงเบราว์เซอร์แทน)';
}

@Component({
  selector: 'app-tts-settings-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="tts-settings-card">
    <h3 class="text-base font-bold text-gray-800"><i class="fas fa-volume-high text-violet-500 me-1"></i>เสียงพูดน้องคิดดี (Google Gemini TTS)</h3>
    <p class="text-xs text-gray-500 mt-1">ประโยคที่เตรียมไว้ใช้ไฟล์เสียงที่สร้างล่วงหน้า — ส่วนนี้คือเสียงแบบสดสำหรับข้อความที่สร้างระหว่างใช้งาน เช่น คำตอบจาก AI
      (ส่งเฉพาะข้อความที่จะอ่านไปยัง Google ไม่ส่งข้อมูลผู้ใช้) ปิดอยู่หรือไม่มีคีย์ = ใช้เสียงของเบราว์เซอร์</p>
    <div *ngIf="loadError" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{{ loadError }}</div>
    <div *ngIf="s" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <div class="flex items-center gap-2 md:col-span-2">
        <input type="checkbox" id="tts-enabled" [(ngModel)]="s.enabled" name="ttsEnabled" class="w-4 h-4">
        <label for="tts-enabled" class="font-bold text-gray-700">เปิดใช้เสียงแบบสด</label>
        <span class="text-[11px] px-2 py-0.5 rounded-full" [ngClass]="s.key_source === 'none' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'" id="tts-key-source">{{ keySource }}</span>
      </div>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">เสียง</span>
        <select id="tts-voice" [(ngModel)]="s.voice" name="ttsVoice" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
          <option *ngFor="let v of voiceOptions" [ngValue]="v.name">{{ v.label }}</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">รุ่นโมเดล</span>
        <input id="tts-model" [(ngModel)]="s.model" name="ttsModel" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white font-mono text-xs" [placeholder]="s.default_model">
        <span class="text-[11px] text-gray-400">ค่าตั้งต้น {{ s.default_model }} (รองรับภาษาไทย)</span>
      </label>
      <label class="block md:col-span-2">
        <span class="text-xs font-bold text-gray-600">คำกำกับน้ำเสียง (บอกบุคลิก จังหวะ อารมณ์ — ไม่ถูกอ่านออกเสียง)</span>
        <textarea id="tts-style" [(ngModel)]="s.style" name="ttsStyle" rows="2" maxlength="500" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white text-xs"></textarea>
        <button type="button" class="text-[11px] text-violet-600 hover:underline" (click)="s.style = s.default_style">ใช้ค่าตั้งต้น</button>
      </label>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">API key (Google AI Studio)</span>
        <input id="tts-api-key" type="password" [(ngModel)]="apiKey" name="ttsKey" autocomplete="new-password" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white"
               [placeholder]="s.has_api_key ? 'บันทึกไว้แล้ว — เว้นว่างเพื่อใช้ค่าเดิม' : 'เว้นว่าง = ใช้คีย์ของผู้ช่วย AI'">
        <label *ngIf="s.has_api_key" class="flex items-center gap-1 text-[11px] text-gray-500 mt-1"><input type="checkbox" [(ngModel)]="clearKey" name="ttsClear"> ลบคีย์ที่บันทึกไว้</label>
      </label>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">โควตาต่อวัน (ประโยค)</span>
        <input type="number" min="1" max="100000" [(ngModel)]="s.daily_limit" name="ttsLimit" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
        <span class="text-[11px] text-gray-400">ประโยคที่ซ้ำกันใช้เสียงที่เก็บไว้ ไม่นับซ้ำ</span>
      </label>
      <label class="block md:col-span-2">
        <span class="text-xs font-bold text-gray-600">ข้อความสำหรับลองฟัง</span>
        <input id="tts-test-text" [(ngModel)]="testText" name="ttsTestText" maxlength="600" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
      </label>
    </div>
    <div *ngIf="s" class="mt-3 flex flex-wrap gap-2 items-center">
      <button type="button" (click)="save()" [disabled]="busy" id="btn-tts-save" class="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการตั้งค่า</button>
      <button type="button" (click)="test()" [disabled]="busy" id="btn-tts-test" class="px-4 py-2 rounded-xl bg-white border border-violet-300 text-violet-700 hover:bg-violet-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-play me-1"></i>ลองฟังเสียงที่เลือก</button>
      <span *ngIf="testMsg" class="text-xs text-gray-500" id="tts-test-msg">{{ testMsg }}</span>
    </div>
  </div>`,
})
export class TtsSettingsCardComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  s: any = null;
  voiceOptions: { name: string; label: string }[] = [];
  keySource = '';
  apiKey = '';
  clearKey = false;
  loadError = '';
  busy = false;
  testText = 'สวัสดีครับ ผมน้องคิดดี วันนี้มีอะไรให้ผมช่วยดูเรื่องผลงานตัวชี้วัดไหมครับ';
  testMsg = '';
  private audio: HTMLAudioElement | null = null;

  ngOnInit() { this.load(); }
  ngOnDestroy() { try { this.audio?.pause(); } catch { /* */ } }

  private apply(d: any) {
    this.s = d || null;
    // ตัวเลือกคำนวณครั้งเดียวตอนโหลด (ไม่ใช้ getter — กัน NG0103)
    this.voiceOptions = (d?.voices || []).map((v: TtsVoice) => ({ name: v.name, label: voiceLabel(v) }));
    this.keySource = keySourceText(d?.key_source || 'none');
  }

  load() {
    this.authService.apiGet('/tts/settings').subscribe({
      next: (res: any) => { this.apply(res?.data); this.cdr.detectChanges(); },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดการตั้งค่าเสียงพูดไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  payload(): any {
    const p: any = { enabled: !!this.s.enabled, voice: this.s.voice, model: String(this.s.model || '').trim() || this.s.default_model,
      style: this.s.style, daily_limit: Number(this.s.daily_limit) };
    if (this.clearKey) p.clear_api_key = true;
    else if (this.apiKey.trim()) p.api_key = this.apiKey.trim();
    return p;
  }

  save() {
    this.busy = true;
    this.authService.apiPut('/tts/settings', this.payload()).subscribe({
      next: (res: any) => {
        this.busy = false; this.apiKey = ''; this.clearKey = false; this.apply(res?.data);
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  /** ลองฟังด้วยเสียง/คำกำกับที่เลือกในฟอร์ม (ยังไม่ต้องบันทึก) — ใช้คีย์ที่บันทึกไว้ */
  test() {
    this.busy = true; this.testMsg = 'กำลังสร้างเสียง...';
    this.authService.apiPost('/tts/test', { text: this.testText, voice: this.s.voice, style: this.s.style, model: this.s.model }).subscribe({
      next: (res: any) => {
        this.busy = false;
        this.testMsg = `ความยาว ${(res.ms / 1000).toFixed(1)} วินาที`;
        try { this.audio?.pause(); this.audio = new Audio(`data:${res.mime || 'audio/wav'};base64,${res.audio}`); this.audio.play().catch(() => { /* */ }); } catch { /* */ }
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.busy = false; this.testMsg = ''; Swal.fire('ลองฟังไม่สำเร็จ', err.error?.message || 'สร้างเสียงไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }
}
