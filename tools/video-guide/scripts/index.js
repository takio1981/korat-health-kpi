// รายการหัวข้อวิดีโอ — id ต้องตรงกับ id หัวข้อในหน้าคู่มือ (help.ts sections / section-<id> ใน help.html)
// roles: 'public' = ไม่ต้องเข้าสู่ระบบ (ใช้ร่วมทุกสิทธิ์) | 'all' = ทุกสิทธิ์ (ถ่ายแยกตามสิทธิ์) | array = เฉพาะสิทธิ์ที่ระบุ
module.exports = [
    ...require('./public'),
    require('./dashboard'),
    ...require('./common'),
    ...require('./admin'),
    ...require('./super'),
];
