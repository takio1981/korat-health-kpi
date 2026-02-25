const fs = require('fs');
const csv = require('csv-parser');
const mysql = require('mysql2/promise');

async function importData() {
    // 1. ตั้งค่าการเชื่อมต่อไปยังพอร์ต 3307
    const connection = await mysql.createConnection({
        host: 'localhost',
        port: 3307, // 👈 วิ่งเข้าเลนใหม่ ไม่ชนกับใครแน่นอน
        user: 'root',
        password: 'rootpassword', 
        database: 'kpi_korat_db'
    });

    console.log('🟢 เชื่อมต่อฐานข้อมูลสำเร็จ! กำลังเริ่มอ่านไฟล์ CSV...');

    const results = [];
    
    fs.createReadStream('report-excel.csv')
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            console.log(`พบข้อมูลทั้งหมด ${results.length} รายการ กำลังนำเข้าตาราง...`);

            for (const row of results) {
                // --- จัดการแผนก (departments) ---
                let deptId = null;
                if (row.dept) {
                    const [deptRows] = await connection.execute('SELECT id FROM departments WHERE dept_code = ?', [row.dept]);
                    if (deptRows.length > 0) {
                        deptId = deptRows[0].id;
                    } else {
                        const [insertDept] = await connection.execute('INSERT INTO departments (dept_code) VALUES (?)', [row.dept]);
                        deptId = insertDept.insertId;
                    }
                }

                // --- จัดการยุทธศาสตร์ (main_yut) ---
                let yutId = null;
                if (row.main_yut) {
                    const [yutRows] = await connection.execute('SELECT id FROM main_yut WHERE yut_name = ?', [row.main_yut]);
                    if (yutRows.length > 0) {
                        yutId = yutRows[0].id;
                    } else {
                        const [insertYut] = await connection.execute('INSERT INTO main_yut (yut_name) VALUES (?)', [row.main_yut]);
                        yutId = insertYut.insertId;
                    }
                }

                // --- จัดการตัวชี้วัดหลัก (kpi_main_indicators) ---
                let mainIndicatorId = null;
                let indicatorName = row.main_indicator ? row.main_indicator : 'ไม่ระบุหมวดหมู่หลัก';
                if (yutId) {
                    const [mainIndRows] = await connection.execute('SELECT id FROM kpi_main_indicators WHERE indicator_name = ? AND yut_id = ?', [indicatorName, yutId]);
                    if (mainIndRows.length > 0) {
                        mainIndicatorId = mainIndRows[0].id;
                    } else {
                        const [insertMainInd] = await connection.execute('INSERT INTO kpi_main_indicators (indicator_name, yut_id) VALUES (?, ?)', [indicatorName, yutId]);
                        mainIndicatorId = insertMainInd.insertId;
                    }
                }

                // --- นำเข้าตัวชี้วัดย่อยทั้งหมด (kpi_indicators) ---
                await connection.execute(`
                    INSERT INTO kpi_indicators 
                    (report_id, report_name, report_code, weight, target_percentage, target_condition, table_process, is_active, dept_id, main_indicator_id) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    row.report_id, 
                    row.report_name, 
                    row.report_code, 
                    row.weight || null, 
                    row.target_percentage || null, 
                    row.target_condition || null, 
                    row.table_process || null, 
                    row.is_active || 1, 
                    deptId, 
                    mainIndicatorId
                ]);
            }

            console.log('✅ นำเข้าข้อมูลเสร็จสมบูรณ์ 100% แล้วครับ!');
            await connection.end(); 
        });
}

importData().catch(err => console.error('❌ เกิดข้อผิดพลาด:', err));