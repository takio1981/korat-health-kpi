import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideToastr } from 'ngx-toastr';

import { routes } from './app.routes';
import { sessionInvalidatedInterceptor } from './interceptors/session-invalidated.interceptor';
import { errorReportInterceptor } from './interceptors/error-report.interceptor';
import { GlobalErrorHandler } from './services/error-reporter.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([sessionInvalidatedInterceptor, errorReportInterceptor])),
    provideAnimationsAsync(),
    provideToastr({
      timeOut: 3000,
      positionClass: 'toast-top-right',
      preventDuplicates: true,
      progressBar: true,
      closeButton: true,
      newestOnTop: true,
      tapToDismiss: false
    }),
    // Global Error Monitoring — catch uncaught client errors
    { provide: ErrorHandler, useClass: GlobalErrorHandler }
  ]
};
