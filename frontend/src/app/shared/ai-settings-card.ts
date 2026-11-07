// การ์ดตั้งค่าผู้ช่วย AI (7 พ.ย. 2569) — ฝังในหน้าตั้งค่าระบบ, โหลด/บันทึกผ่าน /ai/settings เอง (super_admin)
// ผู้ให้บริการ: Claude API (SDK) หรือ API แบบ OpenAI-compatible (Ollama ในเครื่อง / Google Gemini / Groq / OpenRouter)
// API key ไม่ถูกส่งกลับมาที่หน้าจอ (has_api_key เท่านั้น) — ช่องว่าง = คง key เดิม
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

export interface AiModel { id: string; name: string; created?: string | null; free?: boolean; deprecated?: boolean; }

// ข้อความในรายการรุ่น: รหัสรุ่น — ชื่อที่ผู้ให้บริการแสดง (ฟรี / เลิกใช้แล้ว)
export function modelLabel(m: AiModel): string {
  return m.id + (m.name && m.name !== m.id ? ' — ' + m.name : '') + (m.free ? ' (ฟรี)' : '') + (m.deprecated ? ' (เลิกใช้แล้ว)' : '');
}

export interface AiPreset { id: string; label: string; provider: 'anthropic' | 'openai'; base_url: string; model: string; needsKey: boolean; note: string; }

export const AI_PRESETS: AiPreset[] = [
  { id: 'claude', label: 'Claude API (Anthropic)', provider: 'anthropic', base_url: '', model: 'claude-opus-5-5', needsKey: true,
    note: 'คุณภาพภาษาไทยดีที่สุด มีค่าใช้จ่ายตามการใช้งาน — รุ่นประหยัด: claude-sonnet-5-5, claude-haiku-5-5' },
  { id: 'ollama', label: 'Ollama (โมเดลในเครื่องแม่ข่าย)', provider: 'openai', base_url: 'http://localhost:11434/v1', model: '', needsKey: false,
    note: 'ข้อมูลไม่ออกนอกหน่วยงาน ไม่มีค่า API — ต้องติดตั้ง Ollama และดาวน์โหลดโมเดลที่รองรับภาษาไทยก่อน (ระบุชื่อรุ่นตามที่ติดตั้ง)' },
  { id: 'gemini', label: 'Google Gemini (มีโควตาฟรี)', provider: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', needsKey: true,
    note: 'ใช้ API key จาก Google AI Studio — ระบุชื่อรุ่นตามรายการของ Google' },
  { id: 'groq', label: 'Groq (มีโควตาฟรี)', provider: 'openai', base_url: 'https://api.groq.com/openai/v1', model: '', needsKey: true,
    note: 'ใช้ API key จาก console.groq.com — ระบุชื่อรุ่นตามรายการของ Groq' },
  { id: 'openrouter', label: 'OpenRouter (มีรุ่นฟรี)', provider: 'openai', base_url: 'https://openrouter.ai/api/v1', model: '', needsKey: true,
    note: 'รุ่นฟรีมีชื่อลงท้ายด้วย :free — ระบุชื่อรุ่นตามรายการของ OpenRouter' },
  { id: 'custom', label: 'กำหนดเอง (OpenAI-compatible)', provider: 'openai', base_url: '', model: '', needsKey: false, note: 'ระบุ Base URL ที่ลงท้ายก่อน /chat/completions' },
];

// เลือก preset ที่ตรงกับค่าที่บันทึกไว้ (ไม่ตรงตัวใด = กำหนดเอง)
export function presetOf(provider: string, baseUrl: string): string {
  if (provider === 'anthropic') return 'claude';
  const u = String(baseUrl || '').replace(/\/+$/, '');
  return AI_PRESETS.find(p => p.provider === 'openai' && p.base_url && p.base_url === u)?.id || 'custom';
}

@Component({
  selector: 'app-ai-settings-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
    <div class="flex items-center justify-between mb-2 gap-3 flex-wrap">
      <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-wand-magic-sparkles me-2 text-fuchsia-600"></i>ผู้ช่วย AI</h3>
      <span *ngIf="loaded" class="text-xs text-gray-500">ใช้วันนี้ {{ usedToday }} / {{ dailyLimit }} ครั้ง</span>
    </div>
    <p class="text-xs text-gray-500 mb-4">
      ใช้สรุปรายงานและช่วยงานผู้ดูแล — AI <b>เสนอ/สรุปเท่านั้น</b> ไม่บันทึกผลงานหรืออนุมัติแทนผู้ใช้
      ระบบส่งเฉพาะตัวเลขรวมและชื่อตัวชี้วัดตามสิทธิ์ของผู้ใช้ ไม่ส่งข้อมูลส่วนบุคคล
    </p>
    <div *ngIf="!loaded" class="text-sm text-gray-400"><i class="fas fa-spinner fa-spin me-1"></i>กำลังโหลด...</div>
    <div *ngIf="loaded" class="space-y-4">
      <label class="inline-flex items-center cursor-pointer">
        <input type="checkbox" [(ngModel)]="enabled" name="aiEnabled" [ngModelOptions]="{ standalone: true }" class="peer" style="width:0;height:0;opacity:0;position:relative;margin:0;padding:0;border:0;">
        <div class="relative w-11 h-6 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-fuchsia-600 shrink-0"></div>
        <span class="ms-3 text-sm font-bold text-gray-700">{{ enabled ? 'เปิดใช้งานผู้ช่วย AI' : 'ปิดอยู่ (ไม่แสดงปุ่ม AI ในหน้าใดเลย)' }}</span>
      </label>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1">ผู้ให้บริการ</label>
          <select [(ngModel)]="presetId" (ngModelChange)="applyPreset($event)" name="aiPreset" [ngModelOptions]="{ standalone: true }"
                  class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-fuchsia-400 outline-none bg-white">
            <option *ngFor="let p of presets" [value]="p.id">{{ p.label }}</option>
          </select>
          <p class="text-[11px] text-gray-500 mt-1">{{ preset?.note }}</p>
        </div>
        <div *ngIf="provider === 'openai'">
          <label class="block text-sm font-bold text-gray-700 mb-1">Base URL</label>
          <input type="url" [(ngModel)]="baseUrl" name="aiBaseUrl" [ngModelOptions]="{ standalone: true }" placeholder="https://.../v1"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-fuchsia-400 outline-none">
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1 flex items-center justify-between">
            <span>API key <span *ngIf="hasApiKey" class="ms-1 text-[11px] font-normal text-emerald-600"><i class="fas fa-check-circle"></i> บันทึกไว้แล้ว</span></span>
            <button type="button" (click)="showKey = !showKey" class="text-fuchsia-600 font-normal text-[11px]">
              <i class="fas" [ngClass]="showKey ? 'fa-eye-slash' : 'fa-eye'"></i> {{ showKey ? 'ซ่อน' : 'แสดง' }}
            </button>
          </label>
          <input [type]="showKey ? 'text' : 'password'" [(ngModel)]="apiKey" name="aiApiKey" [ngModelOptions]="{ standalone: true }" autocomplete="off"
                 [placeholder]="hasApiKey ? 'เว้นว่าง = ใช้ key เดิม' : (preset?.needsKey ? 'กรอก API key' : 'ไม่จำเป็นสำหรับผู้ให้บริการนี้')"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-fuchsia-400 outline-none">
          <label *ngIf="hasApiKey" class="inline-flex items-center gap-1 mt-1 text-[11px] text-red-600 cursor-pointer">
            <input type="checkbox" [(ngModel)]="clearKey" name="aiClearKey" [ngModelOptions]="{ standalone: true }"> ลบ API key ที่บันทึกไว้
          </label>
          <p class="text-[11px] text-gray-400 mt-1">key ถูกเข้ารหัสในฐานข้อมูล และไม่แสดงกลับที่หน้าจอ</p>
        </div>
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-1">จำนวนครั้งสูงสุดต่อวัน (ทั้งระบบ)</label>
          <input type="number" [(ngModel)]="dailyLimit" name="aiDailyLimit" [ngModelOptions]="{ standalone: true }" min="1" max="10000"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-fuchsia-400 outline-none">
          <p class="text-[11px] text-gray-400 mt-1">กันค่าใช้จ่าย/โควตาฟรีหมด — การกดทดสอบไม่นับ</p>
        </div>
      </div>

      <!-- รุ่นโมเดล: รายการดึงจากผู้ให้บริการโดยตรง (ครบทุกรุ่น) + อัปเดตได้เมื่อมีรุ่นใหม่ — พิมพ์ชื่อรุ่นเองได้เสมอ -->
      <div class="bg-fuchsia-50/40 border border-fuchsia-100 rounded-xl p-4">
        <div class="flex items-center justify-between gap-2 flex-wrap mb-2">
          <label class="text-sm font-bold text-gray-700">รุ่นโมเดล</label>
          <button type="button" (click)="loadModels(true)" [disabled]="modelsLoading"
                  class="px-3 py-1.5 rounded-xl bg-white border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50 text-xs font-bold disabled:opacity-50">
            <i class="fas" [ngClass]="modelsLoading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> อัปเดตรายชื่อรุ่นจากผู้ให้บริการ
          </button>
        </div>
        <p class="text-[11px] text-gray-500 mb-2">
          <ng-container *ngIf="models.length">พบ {{ models.length }} รุ่น<span *ngIf="modelsHidden"> (ซ่อนรุ่นที่ไม่ใช่โมเดลสนทนา {{ modelsHidden }} รุ่น)</span>
            · อัปเดตล่าสุด {{ modelsFetchedAt | date:'d/M/yyyy HH:mm' }}</ng-container>
          <ng-container *ngIf="!models.length && !modelsLoading">ยังไม่มีรายชื่อรุ่น — กด "อัปเดตรายชื่อรุ่นจากผู้ให้บริการ"{{ preset?.needsKey && !hasApiKey ? ' (กรอก API key ก่อน)' : '' }}</ng-container>
        </p>
        <div *ngIf="modelsError" class="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ modelsError }}</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div *ngIf="models.length" class="md:col-span-2 flex gap-2">
            <input *ngIf="models.length > 15" type="text" [(ngModel)]="modelFilter" name="aiModelFilter" [ngModelOptions]="{ standalone: true }" placeholder="ค้นหารุ่น..."
                   class="w-48 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-fuchsia-400 outline-none">
            <select [ngModel]="inList(model) ? model : ''" (ngModelChange)="model = $event || model" name="aiModelPick" [ngModelOptions]="{ standalone: true }"
                    class="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-fuchsia-400 outline-none bg-white">
              <option value="">— เลือกจากรายการ ({{ filteredModels.length }} รุ่น) —</option>
              <option *ngFor="let m of filteredModels" [value]="m.id">{{ modelLabel(m) }}</option>
            </select>
          </div>
          <div class="md:col-span-2">
            <input type="text" [(ngModel)]="model" name="aiModel" [ngModelOptions]="{ standalone: true }" maxlength="100" placeholder="หรือพิมพ์ชื่อรุ่นเอง"
                   class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-fuchsia-400 outline-none">
            <p *ngIf="model && models.length && !inList(model)" class="text-[11px] text-amber-600 mt-1">
              <i class="fas fa-circle-info me-1"></i>รุ่น "{{ model }}" ไม่อยู่ในรายชื่อล่าสุดของผู้ให้บริการ — ตรวจชื่อหรือกดอัปเดตรายชื่อรุ่น</p>
          </div>
        </div>
      </div>

      <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
        <i class="fas fa-triangle-exclamation me-1"></i>บริการแบบฟรีบางรายอาจนำข้อมูลที่ส่งไปใช้พัฒนาโมเดล — ตรวจเงื่อนไขของผู้ให้บริการก่อนเปิดใช้
        (ถ้าข้อมูลห้ามออกนอกหน่วยงาน ให้ใช้ Ollama ในเครื่อง)
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" (click)="save()" [disabled]="saving"
                class="px-4 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-sm font-bold shadow-md disabled:opacity-50">
          <i class="fas fa-save me-1"></i>บันทึกการตั้งค่า AI
        </button>
        <button type="button" (click)="test()" [disabled]="testing || saving"
                class="px-4 py-2 rounded-xl bg-white border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50 text-sm font-bold disabled:opacity-50">
          <i class="fas" [ngClass]="testing ? 'fa-spinner fa-spin' : 'fa-plug'"></i> ทดสอบการเชื่อมต่อ (ใช้ค่าที่บันทึกแล้ว)
        </button>
      </div>
      <div *ngIf="testResult" class="text-sm rounded-lg p-3 border"
           [ngClass]="testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'">
        <i class="fas me-1" [ngClass]="testResult.ok ? 'fa-check-circle' : 'fa-circle-xmark'"></i>{{ testResult.text }}
      </div>
    </div>
  </div>`,
})
export class AiSettingsCardComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  presets = AI_PRESETS;
  loaded = false;
  saving = false;
  testing = false;
  enabled = false;
  presetId = 'claude';
  provider: 'anthropic' | 'openai' = 'anthropic';
  baseUrl = '';
  model = 'claude-opus-5-5';
  apiKey = '';
  hasApiKey = false;
  clearKey = false;
  showKey = false;
  dailyLimit = 200;
  usedToday = 0;
  testResult: { ok: boolean; text: string } | null = null;
  models: AiModel[] = [];
  modelsHidden = 0;
  modelsFetchedAt = '';
  modelsLoading = false;
  modelsError = '';
  modelFilter = '';
  modelLabel = modelLabel;
  private modelsSeq = 0;

  get filteredModels(): AiModel[] {
    const q = this.modelFilter.trim().toLowerCase();
    return q ? this.models.filter(m => (m.id + ' ' + m.name).toLowerCase().includes(q)) : this.models;
  }
  inList(id: string): boolean { return !!id && this.models.some(m => m.id === id); }

  // refresh = false: แสดงรายชื่อล่าสุดที่เก็บไว้ (ไม่มี = ดึงจากผู้ให้บริการ) | true: ดึงใหม่ (เห็นรุ่นใหม่ของผู้ให้บริการ)
  loadModels(refresh: boolean) {
    if (this.provider === 'openai' && !/^https?:\/\//i.test(this.baseUrl.trim())) { this.models = []; this.modelsError = ''; return; }
    const seq = ++this.modelsSeq;
    this.modelsLoading = true;
    this.modelsError = '';
    this.authService.getAiModels({ provider: this.provider, base_url: this.baseUrl.trim(), api_key: this.apiKey.trim(), refresh }).subscribe({
      next: (res) => {
        if (seq !== this.modelsSeq) return; // เปลี่ยนผู้ให้บริการระหว่างรอ — ทิ้งผลเก่า
        this.modelsLoading = false;
        this.models = res?.models || [];
        this.modelsHidden = res?.hidden || 0;
        this.modelsFetchedAt = res?.fetched_at || '';
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (seq !== this.modelsSeq) return;
        this.modelsLoading = false;
        this.models = [];
        // ยังไม่มี key/ยังไม่เคยดึง ตอนเปิดหน้า = ไม่ต้องแสดงเป็นข้อผิดพลาด
        this.modelsError = refresh ? (err.error?.message || 'ดึงรายชื่อรุ่นไม่สำเร็จ') : '';
        this.cdr.detectChanges();
      },
    });
  }

  get preset(): AiPreset | undefined { return this.presets.find(p => p.id === this.presetId); }

  ngOnInit() { this.load(); }

  load() {
    this.authService.getAiSettings().subscribe({
      next: (res) => {
        const d = res?.data || {};
        this.enabled = !!d.enabled;
        this.provider = d.provider === 'openai' ? 'openai' : 'anthropic';
        this.baseUrl = d.base_url || '';
        this.model = d.model || '';
        this.dailyLimit = d.daily_limit || 200;
        this.hasApiKey = !!d.has_api_key;
        this.usedToday = d.used_today || 0;
        this.presetId = presetOf(this.provider, this.baseUrl);
        this.loaded = true;
        this.cdr.detectChanges();
        this.loadModels(false);
      },
      error: () => { this.loaded = true; this.cdr.detectChanges(); },
    });
  }

  applyPreset(id: string) {
    const p = this.presets.find(x => x.id === id);
    if (!p) return;
    this.provider = p.provider;
    if (p.id !== 'custom') this.baseUrl = p.base_url;
    if (p.model) this.model = p.model;
    else if (/^claude-/.test(this.model)) this.model = ''; // รุ่นของ Claude ใช้กับผู้ให้บริการอื่นไม่ได้
    this.models = [];
    this.modelFilter = '';
    this.loadModels(false);
  }

  payload() {
    return {
      enabled: this.enabled, provider: this.provider, base_url: this.provider === 'openai' ? this.baseUrl.trim() : '',
      model: this.model.trim(), daily_limit: Number(this.dailyLimit), api_key: this.apiKey.trim(), clear_api_key: this.clearKey,
    };
  }

  save() {
    this.saving = true;
    this.authService.saveAiSettings(this.payload()).subscribe({
      next: () => {
        this.saving = false;
        this.apiKey = '';
        this.clearKey = false;
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: 'บันทึกการตั้งค่าผู้ช่วย AI แล้ว', timer: 2000, showConfirmButton: false });
        this.load();
      },
      error: (err) => {
        this.saving = false;
        this.cdr.detectChanges();
        Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error');
      },
    });
  }

  test() {
    this.testing = true;
    this.testResult = null;
    this.authService.testAi().subscribe({
      next: (res) => {
        this.testing = false;
        this.testResult = { ok: true, text: `${res.text} (รุ่น ${res.model}, ${(res.ms / 1000).toFixed(1)} วินาที)` };
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.testing = false;
        this.testResult = { ok: false, text: err.error?.message || 'ทดสอบไม่สำเร็จ' };
        this.cdr.detectChanges();
      },
    });
  }
}
