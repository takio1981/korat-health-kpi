import { Component, signal, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IdleTimeoutService } from './services/idle-timeout.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  protected readonly title = signal('Korat Health KPI');
  private idleTimeoutService = inject(IdleTimeoutService);

  ngOnInit() {
    this.idleTimeoutService.start();
  }

  ngOnDestroy() {
    this.idleTimeoutService.stop();
  }
}
