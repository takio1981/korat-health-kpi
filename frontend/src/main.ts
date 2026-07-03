import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';

// ======================================================
// ThaiD SSO Relay — ก่อน bootstrap Angular
// เมื่อ DGA redirect กลับมาที่ /authen/thaid/callback
// nginx ไม่รู้จัก path นี้ จึง serve SPA (index.html)
// เราต้อง forward query params ไปยัง API endpoint
// ที่ nginx รู้จักก่อน (/khupskpi/api/auth/thaid/callback)
// ======================================================
const _path = window.location.pathname;
if (_path.endsWith('/authen/thaid/callback') || _path.includes('/authen/thaid/callback')) {
  // Forward ทันทีก่อน Angular bootstrap (ไม่ render UI)
  const _apiCallback = '/khupskpi/api/auth/thaid/callback' + window.location.search;
  window.location.replace(_apiCallback);
  // หยุด — ไม่ bootstrap Angular ในครั้งนี้
} else {
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
}
