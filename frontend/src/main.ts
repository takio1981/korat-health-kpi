import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';

// ปิด console.log / debug / info ใน production (เก็บ warn / error ไว้สำหรับ debug จริง)
if (environment.production) {
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.trace = noop;
}

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
