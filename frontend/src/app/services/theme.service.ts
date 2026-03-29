import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private darkMode$ = new BehaviorSubject<boolean>(false);
  isDarkMode$ = this.darkMode$.asObservable();

  constructor() {
    const saved = localStorage.getItem('kpi_dark_mode');
    if (saved === 'true') this.enableDark();
  }

  toggle() {
    this.darkMode$.value ? this.disableDark() : this.enableDark();
  }

  private enableDark() {
    document.documentElement.classList.add('dark');
    localStorage.setItem('kpi_dark_mode', 'true');
    this.darkMode$.next(true);
  }

  private disableDark() {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('kpi_dark_mode', 'false');
    this.darkMode$.next(false);
  }

  get isDark(): boolean { return this.darkMode$.value; }
}
