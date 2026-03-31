import { Component, OnInit, OnChanges, SimpleChanges, ChangeDetectorRef, inject, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

interface FormField {
  id?: number;
  field_name: string;
  field_label: string;
  field_type: 'text' | 'number' | 'textarea' | 'select' | 'date' | 'checkbox';
  field_options: string[];
  is_required: boolean;
  sort_order: number;
  _optionsText?: string;
}

@Component({
  selector: 'app-form-builder',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './form-builder.html'
})
export class FormBuilderComponent implements OnInit, OnChanges {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  @Input() hdcColumns: any[] = [];
  @Input() hdcTableName: string = '';
  @Input() hdcTrigger: number = 0;

  private pendingAutoOpen = '';

  isLoading = false;
  isSaving = false;

  // รายการ indicators ทั้งหมด
  allIndicators: any[] = [];
  filteredIndicators: any[] = [];
  searchText = '';

  // Schema ที่กำลังแก้ไข
  selectedIndicator: any = null;
  editingSchemaId: number | null = null;
  formTitle = '';
  formDescription = '';
  actualValueField = '';   // ฟิลด์ที่ sync ไปยัง kpi_results.actual_value
  fields: FormField[] = [];

  includeDefaultFields = true;  // สร้างฟิลด์เริ่มต้น id, hospcode, year_bh, month_bh, created_by, created_at

  // modal
  showBuilderModal = false;
  showPreviewModal = false;
  previewData: any = {};

  fieldTypeOptions = [
    { value: 'text', label: 'ข้อความสั้น' },
    { value: 'number', label: 'ตัวเลข' },
    { value: 'textarea', label: 'ข้อความยาว' },
    { value: 'select', label: 'รายการเลือก (Dropdown)' },
    { value: 'date', label: 'วันที่' },
    { value: 'checkbox', label: 'ช่องเลือก (Checkbox)' },
  ];

  ngOnInit() {
    this.loadIndicators();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['hdcTrigger'] && this.hdcTableName) {
      this.tryAutoOpenIndicator(this.hdcTableName);
    }
  }

  private tryAutoOpenIndicator(tableName: string) {
    if (this.allIndicators.length === 0) {
      // indicators ยังไม่โหลด → จำไว้เปิดทีหลัง
      this.pendingAutoOpen = tableName;
      return;
    }
    const match = this.allIndicators.find(i => i.table_process === tableName);
    if (match) {
      this.openCreateForm(match);
    }
  }

  loadIndicators() {
    this.isLoading = true;
    this.authService.getAllIndicatorsWithSchema().subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.allIndicators = res.data;
          this.applyFilter();
          // ถ้ามี pending auto-open จาก HDC → เปิดเลย
          if (this.pendingAutoOpen) {
            const tableName = this.pendingAutoOpen;
            this.pendingAutoOpen = '';
            this.tryAutoOpenIndicator(tableName);
          }
        }
        this.cdr.detectChanges();
      },
      error: () => { this.isLoading = false; this.cdr.detectChanges(); }
    });
  }

  applyFilter() {
    const q = this.searchText.toLowerCase();
    this.filteredIndicators = q
      ? this.allIndicators.filter(i =>
          i.kpi_indicators_name.toLowerCase().includes(q) ||
          (i.dept_name || '').toLowerCase().includes(q) ||
          (i.table_process || '').toLowerCase().includes(q)
        )
      : [...this.allIndicators];
  }

  openCreateForm(indicator: any) {
    this.selectedIndicator = indicator;
    this.editingSchemaId = indicator.schema_id || null;
    this.formTitle = indicator.form_title || `แบบฟอร์ม: ${indicator.kpi_indicators_name}`;
    this.formDescription = '';
    this.fields = [];
    this.includeDefaultFields = true;

    if (indicator.schema_id) {
      // โหลด fields เดิม
      this.authService.getFormSchemaByIndicator(indicator.id).subscribe({
        next: (res) => {
          if (res.success && res.data) {
            this.formTitle = res.data.form_title;
            this.formDescription = res.data.form_description || '';
            this.actualValueField = res.data.actual_value_field || '';
            this.fields = (res.data.fields || []).map((f: any) => ({
              ...f,
              field_options: f.field_options ? this.parseOptions(f.field_options) : [],
              _optionsText: f.field_options ? this.parseOptions(f.field_options).join('\n') : ''
            }));
          }
          this.showBuilderModal = true;
          this.cdr.detectChanges();
        }
      });
    } else {
      this.actualValueField = '';
      this.addField();
      this.showBuilderModal = true;
    }
  }

  parseOptions(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  addField() {
    this.fields.push({
      field_name: '',
      field_label: '',
      field_type: 'text',
      field_options: [],
      is_required: false,
      sort_order: this.fields.length,
      _optionsText: ''
    });
  }

  removeField(index: number) {
    this.fields.splice(index, 1);
  }

  moveField(index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || to >= this.fields.length) return;
    [this.fields[index], this.fields[to]] = [this.fields[to], this.fields[index]];
  }

  onOptionsTextChange(field: FormField) {
    field.field_options = (field._optionsText || '').split('\n').map(s => s.trim()).filter(Boolean);
  }

  autoFieldName(field: FormField) {
    if (!field.field_name && field.field_label) {
      field.field_name = field.field_label
        .replace(/[^a-zA-Z0-9\u0E00-\u0E7F\s]/g, '')
        .trim()
        .split(/\s+/)
        .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      // ถ้าชื่อเป็น Thai ให้ใส่ prefix
      if (/[^\x00-\x7F]/.test(field.field_name)) {
        field.field_name = 'field_' + (this.fields.indexOf(field) + 1);
      }
    }
  }

  get isFormValid(): boolean {
    if (!this.formTitle.trim()) return false;
    if (!this.selectedIndicator?.table_process) return false;
    if (this.fields.length === 0) return false;
    return this.fields.every(f =>
      f.field_name.trim() && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(f.field_name) && f.field_label.trim()
    );
  }

  saveSchema() {
    if (!this.isFormValid) {
      Swal.fire('ข้อมูลไม่ครบถ้วน', 'กรุณากรอกชื่อฟอร์ม และตรวจสอบชื่อคอลัมน์ทุกช่อง (ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร)', 'warning');
      return;
    }
    this.isSaving = true;
    const payload = {
      indicator_id: this.selectedIndicator.id,
      form_title: this.formTitle,
      form_description: this.formDescription,
      schema_id: this.editingSchemaId,
      actual_value_field: this.actualValueField || null,
      include_default_fields: this.includeDefaultFields,
      fields: this.fields.map((f, i) => ({
        field_name: f.field_name,
        field_label: f.field_label,
        field_type: f.field_type,
        field_options: f.field_options,
        is_required: f.is_required,
        sort_order: i
      }))
    };
    this.authService.saveFormSchema(payload).subscribe({
      next: (res) => {
        this.isSaving = false;
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          this.showBuilderModal = false;
          // เคลียร์ HDC data
          this.hdcColumns.forEach(c => c._selected = false);
          this.includeDefaultFields = true;
          this.loadIndicators();
        } else {
          Swal.fire('ผิดพลาด', res.message, 'error');
        }
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.isSaving = false;
        Swal.fire('ผิดพลาด', e.error?.message || 'เกิดข้อผิดพลาด', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  deleteSchema(indicator: any) {
    if (!indicator.schema_id) return;
    Swal.fire({
      title: 'ลบแบบฟอร์ม?',
      text: `ต้องการลบแบบฟอร์มของ "${indicator.kpi_indicators_name}" ใช่หรือไม่? ตารางข้อมูลจะยังคงอยู่`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteFormSchema(indicator.schema_id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'ลบเรียบร้อย', timer: 1500, showConfirmButton: false });
              this.loadIndicators();
            }
          }
        });
      }
    });
  }

  openPreview() {
    this.previewData = {};
    this.showPreviewModal = true;
  }

  isAllHdcSelected(): boolean {
    return this.hdcColumns.length > 0 && this.hdcColumns.every(c => c._selected);
  }

  toggleSelectAllHdc(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.hdcColumns.forEach(c => c._selected = checked);
  }

  getSelectedHdcCount(): number {
    return this.hdcColumns.filter(c => c._selected).length;
  }

  applyHdcFields() {
    const selected = this.hdcColumns.filter(c => c._selected);
    if (selected.length === 0) return;
    // ลบ field เปล่าที่ยังไม่ได้กรอก
    this.fields = this.fields.filter(f => f.field_name.trim());
    const existingNames = new Set(this.fields.map(f => f.field_name));
    for (const col of selected) {
      if (!existingNames.has(col.field)) {
        this.fields.push({
          field_name: col.field,
          field_label: col.field,
          field_type: this.mapHdcType(col.type),
          field_options: [],
          is_required: false,
          sort_order: this.fields.length,
          _optionsText: ''
        });
      }
    }
    this.cdr.detectChanges();
  }

  mapHdcType(dbType: string): 'text' | 'number' | 'textarea' | 'select' | 'date' | 'checkbox' {
    if (!dbType) return 'text';
    const t = dbType.toLowerCase();
    if (t.includes('int') || t.includes('decimal') || t.includes('float') || t.includes('double')) return 'number';
    if (t.includes('date') || t.includes('time')) return 'date';
    if (t.includes('text') || t.includes('blob')) return 'textarea';
    return 'text';
  }

  closeBuilderModal() {
    this.showBuilderModal = false;
    this.selectedIndicator = null;
    this.fields = [];
  }
}
