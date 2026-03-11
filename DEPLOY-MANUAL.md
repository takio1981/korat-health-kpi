# คู่มือการ Deploy ระบบ Korat Health KPI
## ขั้นตอนการติดตั้งและ Deploy บน Production Server

---

## สารบัญ

1. [ภาพรวม Architecture](#1-ภาพรวม-architecture)
2. [ความต้องการของระบบ](#2-ความต้องการของระบบ)
3. [ครั้งแรก: ตั้งค่า Server (Linux)](#3-ครั้งแรก-ตั้งค่า-server-linux)
4. [ครั้งแรก: ตั้งค่าฐานข้อมูล (MariaDB)](#4-ครั้งแรก-ตั้งค่าฐานข้อมูล-mariadb)
5. [Build บนเครื่อง Windows](#5-build-บนเครื่อง-windows)
6. [Transfer ไฟล์ขึ้น Server](#6-transfer-ไฟล์ขึ้น-server)
7. [ตั้งค่า .env บน Server](#7-ตั้งค่า-env-บน-server)
8. [รัน Docker Compose บน Server](#8-รัน-docker-compose-บน-server)
9. [ตรวจสอบระบบ](#9-ตรวจสอบระบบ)
10. [อัปเดตระบบ (ครั้งถัดไป)](#10-อัปเดตระบบ-ครั้งถัดไป)
11. [คำสั่ง Docker ที่ใช้บ่อย](#11-คำสั่ง-docker-ที่ใช้บ่อย)
12. [แก้ปัญหาที่พบบ่อย](#12-แก้ปัญหาที่พบบ่อย)

---

## 1. ภาพรวม Architecture

```
┌─────────────────────────────┐       ┌──────────────────────────────────┐
│   Developer Machine         │       │   Production Server (Linux)      │
│   (Windows)                 │       │                                  │
│                             │       │  ┌────────────────────────────┐  │
│  1. แก้โค้ด                 │       │  │  Docker Container          │  │
│  2. รัน build.bat            │──────►│  │  khups_kpi_frontend:8881   │  │
│     (ng build + api build)  │ rsync │  │  (nginx + Angular dist)    │  │
│  3. rsync ไฟล์ขึ้น server   │       │  └────────────┬───────────────┘  │
│                             │       │               │ proxy /api        │
└─────────────────────────────┘       │  ┌────────────▼───────────────┐  │
                                      │  │  Docker Container          │  │
┌─────────────────────────────┐       │  │  khups_kpi_backend:8830    │  │
│   Database Server (MariaDB) │◄──────│  │  (Node.js + PM2)          │  │
│   192.168.88.100:3306       │       │  └────────────────────────────┘  │
└─────────────────────────────┘       └──────────────────────────────────┘
```

**Ports ที่ใช้:**

| Port | Service | คำอธิบาย |
|------|---------|---------|
| `8881` | Frontend (nginx) | เข้าใช้งานเว็บ: `http://server:8881/khupskpi/` |
| `8830` | Backend (Node.js) | API: `http://server:8830/khupskpi/api` |
| `3306` | MariaDB | ฐานข้อมูล (ต้องเปิด firewall จาก server ไปหา DB) |

---

## 2. ความต้องการของระบบ

### เครื่อง Developer (Windows)

| รายการ | เวอร์ชัน | ใช้ทำอะไร |
|--------|---------|---------|
| Node.js | 20+ | รัน Angular CLI |
| Angular CLI | 21+ | Build Frontend |
| Docker Desktop | latest | ทดสอบ local |

ติดตั้ง Angular CLI:
```cmd
npm install -g @angular/cli
```

### Production Server (Linux)

| รายการ | เวอร์ชัน | หมายเหตุ |
|--------|---------|---------|
| OS | CentOS 8+ / RHEL 8+ / Ubuntu 20+ | - |
| Docker | 24+ | ต้องติดตั้ง |
| Docker Compose | v2 | (รวมกับ Docker แล้ว) |
| RAM | 2 GB+ | ขั้นต่ำ |
| Disk | 10 GB+ | รวม Docker images |

### Database Server (MariaDB)

| รายการ | เวอร์ชัน |
|--------|---------|
| MariaDB | 11.4+ |

---

## 3. ครั้งแรก: ตั้งค่า Server (Linux)

> **ทำเพียงครั้งเดียว** เมื่อ deploy ครั้งแรก

### 3.1 ติดตั้ง Docker

```bash
# CentOS / RHEL / Rocky Linux
sudo dnf install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# เริ่มต้นและเปิดใช้งาน Docker
sudo systemctl start docker
sudo systemctl enable docker

# ทดสอบ
docker --version
docker compose version
```

```bash
# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

sudo systemctl start docker
sudo systemctl enable docker
```

### 3.2 เปิด Firewall Ports

```bash
# CentOS / RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=8881/tcp   # Frontend
sudo firewall-cmd --permanent --add-port=8830/tcp   # Backend API
sudo firewall-cmd --reload

# ตรวจสอบ
sudo firewall-cmd --list-ports
```

```bash
# Ubuntu (ufw)
sudo ufw allow 8881/tcp
sudo ufw allow 8830/tcp
sudo ufw reload
```

### 3.3 สร้างโฟลเดอร์สำหรับ Application

```bash
sudo mkdir -p /opt/apps/korat-health-kpi
sudo chown $USER:$USER /opt/apps/korat-health-kpi
```

---

## 4. ครั้งแรก: ตั้งค่าฐานข้อมูล (MariaDB)

> **ทำบน Database Server (192.168.88.100)** เพียงครั้งเดียว

### 4.1 สร้างฐานข้อมูลและ User

```sql
-- Login เข้า MariaDB ด้วย root
mysql -u root -p

-- สร้างฐานข้อมูล
CREATE DATABASE IF NOT EXISTS `khups_kpi_db`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

-- สร้าง user สำหรับ application
-- (เปลี่ยน 'StrongPassword123!' เป็นรหัสผ่านจริง)
CREATE USER 'kpi_user'@'%' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON `khups_kpi_db`.* TO 'kpi_user'@'%';
FLUSH PRIVILEGES;

-- ตรวจสอบ
SHOW GRANTS FOR 'kpi_user'@'%';
EXIT;
```

### 4.2 Import Database Schema + Data

```bash
# รันบนเครื่อง Developer หรือ Database Server
# ที่มีไฟล์ database/ อยู่

# Step 1: สร้าง database
mysql -h 192.168.88.100 -u root -p < database/setup.sql

# Step 2: Import ตารางและข้อมูลทั้งหมด
mysql -h 192.168.88.100 -u root -p khups_kpi_db < database/khups_kpi_db_2.sql
```

> **หมายเหตุ**: `khups_kpi_db_2.sql` มีทั้ง structure + seed data ครบทุกตาราง (13 ตาราง)

### 4.3 ตรวจสอบ User Authentication Plugin

MariaDB ต้องใช้ `mysql_native_password` ไม่ใช่ `auth_gssapi_client`:

```sql
-- ตรวจสอบ
SELECT user, host, plugin FROM mysql.user WHERE user = 'kpi_user';

-- ถ้า plugin ไม่ใช่ mysql_native_password ให้รัน
ALTER USER 'kpi_user'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('StrongPassword123!');
FLUSH PRIVILEGES;
```

### 4.4 ตั้งค่า MariaDB ให้รับ Connection จาก Docker

แก้ไขไฟล์ `/etc/mysql/mariadb.conf.d/50-server.cnf` หรือ `/etc/my.cnf`:

```ini
[mysqld]
# อนุญาตให้รับ connection จากทุก IP (หรือระบุ IP เฉพาะ)
bind-address = 0.0.0.0
```

```bash
sudo systemctl restart mariadb
```

---

## 5. Build บนเครื่อง Windows

> **ทำบนเครื่อง Developer (Windows)** ทุกครั้งที่มีการเปลี่ยนโค้ด

### 5.1 ตรวจสอบ Prerequisites

```cmd
node --version     # ต้องเป็น v20+
ng version         # ต้องเป็น Angular CLI 21+
```

### 5.2 รัน build.bat

```cmd
cd D:\it-ssjnma-project\korat-health-kpi
build.bat
```

build.bat จะทำขั้นตอนต่อไปนี้อัตโนมัติ:

| ขั้นตอน | การทำงาน | Output |
|---------|---------|--------|
| [1/5] Clean | ลบ `frontend\dist` และ `api\dist` เก่า | - |
| [2/5] ng build | Build Angular → `frontend\dist\` | `frontend\dist\index.html` + assets |
| [3/5] API build | Copy server.js, db.js → `api\dist\` + `npm install --production` | `api\dist\server.js`, `api\node_modules\` |
| [4/5] Docker | `docker compose down` + `up -d --build` (local test) | Containers ใน Docker Desktop |
| [5/5] Verify | แสดงสถานะ containers | - |

### 5.3 ตรวจสอบผลการ Build

หลัง build.bat เสร็จ ตรวจสอบว่ามีไฟล์เหล่านี้:

```
korat-health-kpi/
├── frontend/
│   ├── dist/              ← Angular built files (index.html, main-*.js, ...)
│   ├── Dockerfile
│   └── nginx.conf
├── api/
│   ├── dist/
│   │   ├── server.js      ← Backend (copied from api/)
│   │   └── db.js
│   ├── node_modules/      ← Production dependencies
│   ├── package.json
│   ├── ecosystem.config.js
│   └── Dockerfile
├── docker-compose.yml
└── .env                   ← ต้องมีก่อน deploy
```

---

## 6. Transfer ไฟล์ขึ้น Server

> **เลือกวิธีที่สะดวก:**

### วิธี A: rsync (แนะนำ — เร็วที่สุด)

```bash
# รันบน Git Bash หรือ WSL บน Windows
# เปลี่ยน user@192.168.x.x เป็น IP จริงของ server

rsync -avz --progress \
  --exclude='.git' \
  --exclude='.angular' \
  --exclude='frontend/src' \
  --exclude='frontend/node_modules' \
  --exclude='api/.env' \
  --exclude='api/.env.dev' \
  /d/it-ssjnma-project/korat-health-kpi/ \
  root@192.168.x.x:/opt/apps/korat-health-kpi/
```

**ไฟล์ที่จำเป็นต้อง transfer (ขั้นต่ำ):**

```bash
# Transfer เฉพาะไฟล์จำเป็น (ถ้า bandwidth จำกัด)
rsync -avz --progress \
  frontend/dist/ \
  frontend/Dockerfile \
  frontend/nginx.conf \
  api/dist/ \
  api/node_modules/ \
  api/package.json \
  api/ecosystem.config.js \
  api/Dockerfile \
  docker-compose.yml \
  root@192.168.x.x:/opt/apps/korat-health-kpi/
```

### วิธี B: SCP (Windows CMD)

```cmd
REM ต้องติดตั้ง OpenSSH หรือ PuTTY scp
REM เปลี่ยน user@192.168.x.x เป็น IP จริง

scp -r frontend\dist root@192.168.x.x:/opt/apps/korat-health-kpi/frontend/
scp -r api\dist root@192.168.x.x:/opt/apps/korat-health-kpi/api/
scp -r api\node_modules root@192.168.x.x:/opt/apps/korat-health-kpi/api/
scp api\package.json api\ecosystem.config.js api\Dockerfile root@192.168.x.x:/opt/apps/korat-health-kpi/api/
scp frontend\Dockerfile frontend\nginx.conf root@192.168.x.x:/opt/apps/korat-health-kpi/frontend/
scp docker-compose.yml root@192.168.x.x:/opt/apps/korat-health-kpi/
```

### วิธี C: WinSCP (GUI)

1. เปิด **WinSCP**
2. Connect ไปที่ server
3. Drag & Drop โฟลเดอร์ `api/dist/`, `api/node_modules/`, `frontend/dist/`, และไฟล์อื่นๆ

---

## 7. ตั้งค่า .env บน Server

> **ทำบน Server** — ห้าม commit ไฟล์นี้ขึ้น git เด็ดขาด

```bash
# SSH เข้า server
ssh root@192.168.x.x

# ไปที่โฟลเดอร์โปรเจค
cd /opt/apps/korat-health-kpi

# สร้างไฟล์ .env (copy จาก example แล้วแก้ค่า)
cp .env.example .env
nano .env
```

**เนื้อหาใน .env ที่ต้องกรอก:**

```env
# ============================================
#  Production Environment — NEVER commit this
# ============================================

# DB_HOST ไม่ต้องกรอก — docker-compose ใช้ host.docker.internal อัตโนมัติ
DB_HOST=
DB_PORT=3306
DB_NAME=khups_kpi_db
DB_USER=kpi_user
DB_PASSWORD=StrongPassword123!

# Secret Key สำหรับ JWT — ใช้ค่าสุ่มที่ยาวและซับซ้อน
SECRET_KEY=Korat_KPI_Production_SecretKey_2569_ChangeThis!
```

> **สร้าง SECRET_KEY แบบสุ่ม:**
> ```bash
> openssl rand -base64 48
> ```

**ตรวจสอบ permissions:**
```bash
chmod 600 .env
ls -la .env
# ต้องเห็น: -rw------- (อ่านได้เฉพาะ owner เท่านั้น)
```

---

## 8. รัน Docker Compose บน Server

```bash
cd /opt/apps/korat-health-kpi

# ครั้งแรก หรือ หลัง transfer ไฟล์ใหม่
docker compose down
docker compose up -d --build

# ดูสถานะ
docker compose ps
```

**ผลลัพธ์ที่ต้องการ:**

```
NAME                    STATUS          PORTS
khups_kpi_backend       healthy         0.0.0.0:8830->8830/tcp
khups_kpi_frontend      running         0.0.0.0:8881->8881/tcp
```

> `khups_kpi_backend` ต้องเป็น **healthy** (ผ่าน health check) ก่อน frontend จะ start

---

## 9. ตรวจสอบระบบ

### 9.1 ตรวจสอบ Container Logs

```bash
# ดู log ทั้งหมด
docker compose logs

# ดู log แบบ real-time
docker compose logs -f

# ดูเฉพาะ backend
docker compose logs backend

# ดู log ย้อนหลัง 50 บรรทัด
docker logs khups_kpi_backend --tail 50
docker logs khups_kpi_frontend --tail 50
```

**Log ที่ต้องเห็นเมื่อ backend พร้อม:**
```
[dotenv] Production mode — using environment variables
✅ login_logs, system_logs, notifications & rejection tables ready
Server running on port 8830
```

### 9.2 ทดสอบ API

```bash
# ทดสอบ Health Check Endpoint
curl http://localhost:8830/khupskpi/api/
# ผลลัพธ์: {"status":"ok","service":"KHUPS KPI API"}

# ทดสอบผ่าน Frontend (nginx proxy)
curl http://localhost:8881/khupskpi/api/
# ผลลัพธ์: {"status":"ok","service":"KHUPS KPI API"}
```

### 9.3 ทดสอบ Frontend

```bash
# ทดสอบว่า nginx ส่ง index.html
curl -I http://localhost:8881/khupskpi/
# ต้องเห็น: HTTP/1.1 200 OK
```

### 9.4 เข้าใช้งานจากเบราว์เซอร์

```
http://[server-ip]:8881/khupskpi/
```

**บัญชีเริ่มต้น (จาก seed data):**

| Username | Password | Role |
|----------|----------|------|
| `takio1981` | (ดูในฐานข้อมูล) | super_admin |
| `admin_korat` | (ดูในฐานข้อมูล) | admin_ssj |

> ถ้า password ไม่ทราบ ให้ reset โดยตรงใน database:
> ```sql
> -- password = 'admin1234' (bcrypt hash)
> UPDATE users SET password_hash='$2b$10$8PFpvSK1kix3eX3T00ovDeAySOnTHijl0lt2T6s/NKfR6LP5nbkPi' WHERE username='takio1981';
> ```

---

## 10. อัปเดตระบบ (ครั้งถัดไป)

### ขั้นตอนมาตรฐาน (Windows → Server)

```
1. แก้โค้ดบน Windows
2. รัน build.bat (build.bat จะ build + deploy ไปยัง Docker local ด้วย)
3. ทดสอบบน http://localhost:8881/khupskpi/
4. Transfer ไฟล์ที่เปลี่ยนขึ้น server
5. รัน docker compose บน server
```

### Step-by-Step Commands

**บนเครื่อง Windows:**
```cmd
REM 1. Build
cd D:\it-ssjnma-project\korat-health-kpi
build.bat

REM 2. Transfer (Git Bash)
rsync -avz --progress ^
  --exclude='.git' --exclude='.angular' ^
  --exclude='frontend/src' --exclude='api/.env*' ^
  /d/it-ssjnma-project/korat-health-kpi/ ^
  root@192.168.x.x:/opt/apps/korat-health-kpi/
```

**บน Server:**
```bash
cd /opt/apps/korat-health-kpi

# Rebuild และ restart containers
docker compose down
docker compose up -d --build

# ตรวจสอบ
docker compose ps
docker compose logs backend --tail 20
```

### อัปเดตเฉพาะ Frontend (ไม่มีการเปลี่ยน API)

```bash
# Transfer เฉพาะ frontend dist
rsync -avz frontend/dist/ root@192.168.x.x:/opt/apps/korat-health-kpi/frontend/dist/

# Rebuild เฉพาะ frontend container
docker compose up -d --build frontend
```

### อัปเดตเฉพาะ Backend (ไม่มีการเปลี่ยน Frontend)

```bash
# Transfer เฉพาะ api dist
rsync -avz api/dist/ api/node_modules/ root@192.168.x.x:/opt/apps/korat-health-kpi/api/

# Rebuild เฉพาะ backend container
docker compose up -d --build backend
```

---

## 11. คำสั่ง Docker ที่ใช้บ่อย

```bash
# ดูสถานะ containers
docker compose ps

# ดู logs แบบ real-time
docker compose logs -f

# Restart ทั้งหมด
docker compose restart

# หยุดทั้งหมด
docker compose down

# Start ใหม่ (ไม่ rebuild)
docker compose up -d

# Rebuild + Start
docker compose up -d --build

# เข้าไปใน container (debug)
docker exec -it khups_kpi_backend sh
docker exec -it khups_kpi_frontend sh

# ดู resource usage
docker stats

# ลบ images เก่า (ประหยัด disk)
docker image prune -f

# ดู network
docker network ls
docker network inspect korat-health-kpi_kpi_network
```

---

## 12. แก้ปัญหาที่พบบ่อย

### ปัญหา: Container backend ไม่ Healthy

```bash
# ดู logs
docker logs khups_kpi_backend --tail 50

# สาเหตุที่พบบ่อย:
# 1. ECONNREFUSED ::1:3306  → DB_HOST ผิด (localhost แทน IP จริง)
# 2. AUTH_SWITCH_PLUGIN_ERROR → MariaDB user ใช้ GSSAPI ต้องเปลี่ยนเป็น native password
# 3. Access denied → DB_USER หรือ DB_PASSWORD ผิด
# 4. Module not found → node_modules ไม่ครบ ต้อง build.bat ใหม่
```

**แก้ปัญหา DB_HOST:**

`docker-compose.yml` ตั้งค่า `DB_HOST: host.docker.internal` ไว้แล้ว — ไม่ต้องแก้ `.env`
ตรวจสอบว่า MariaDB server รับ connection จาก `host.docker.internal` ได้

```bash
# ทดสอบ connectivity จากใน container
docker exec -it khups_kpi_backend sh
apk add --no-cache mariadb-client
mysql -h host.docker.internal -u kpi_user -p khups_kpi_db
```

**แก้ปัญหา Auth Plugin:**

```sql
-- รันบน MariaDB server
ALTER USER 'kpi_user'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('StrongPassword123!');
FLUSH PRIVILEGES;
```

---

### ปัญหา: `npm error ENOENT: package.json not found`

```
npm error enoent Could not read package.json
```

**สาเหตุ**: ไม่ได้ transfer ไฟล์ให้ครบ หรือพยายามรัน `npm install` บน server โดยตรง

**วิธีแก้**: ไม่ต้องรัน `npm install` บน server — ทำ build บน Windows แล้ว transfer `api/node_modules/` ขึ้นมาแทน

```bash
# ตรวจสอบว่ามีไฟล์ครบ
ls /opt/apps/korat-health-kpi/api/
# ต้องมี: dist/ node_modules/ package.json ecosystem.config.js Dockerfile
ls /opt/apps/korat-health-kpi/frontend/
# ต้องมี: dist/ Dockerfile nginx.conf
```

---

### ปัญหา: Frontend แสดง 404 หรือ Blank Page

```bash
# ตรวจสอบว่า dist มีไฟล์
docker exec -it khups_kpi_frontend ls /usr/share/nginx/html/khupskpi/
# ต้องเห็น index.html

# ตรวจสอบ nginx config
docker exec -it khups_kpi_frontend cat /etc/nginx/conf.d/default.conf

# ดู nginx error log
docker exec -it khups_kpi_frontend cat /var/log/nginx/error.log
```

---

### ปัญหา: API 500 Error หลัง Login

```bash
# ดู error จาก backend
docker logs khups_kpi_backend --tail 30

# ทดสอบ API ตรงๆ
curl -X POST http://localhost:8830/khupskpi/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"takio1981","password":"yourpassword"}'
```

---

### ปัญหา: Port 8881 หรือ 8830 ถูกใช้งานอยู่แล้ว

```bash
# ดูว่า port ถูกใช้โดยอะไร
ss -tlnp | grep 8881
ss -tlnp | grep 8830

# หยุด process นั้น หรือเปลี่ยน port ใน docker-compose.yml
```

---

### ปัญหา: Docker out of disk space

```bash
# ดูการใช้ disk
docker system df

# ลบ images, containers, volumes ที่ไม่ใช้
docker system prune -a -f
```

---

## สรุปขั้นตอนแบบย่อ (Quick Reference)

### ติดตั้งครั้งแรก

```
[DB Server]
1. mysql → CREATE DATABASE + CREATE USER + GRANT
2. mysql < setup.sql
3. mysql khups_kpi_db < khups_kpi_db_2.sql

[Linux Server]
4. ติดตั้ง Docker
5. mkdir /opt/apps/korat-health-kpi
6. เปิด firewall port 8881, 8830

[Windows]
7. build.bat  (build ครั้งแรก)

[Transfer]
8. rsync ทุกไฟล์ขึ้น server

[Server]
9. สร้าง .env → ใส่ DB_USER, DB_PASSWORD, SECRET_KEY
10. docker compose up -d --build
11. ตรวจสอบ docker compose ps → backend: healthy
12. เข้า http://server-ip:8881/khupskpi/
```

### อัปเดต (Deploy ครั้งถัดไป)

```
[Windows]
1. แก้โค้ด
2. build.bat
3. rsync ขึ้น server

[Server]
4. docker compose up -d --build
5. docker compose ps
```

---

*อัปเดตล่าสุด: มีนาคม 2569 | เวอร์ชันระบบ v1.0.0*
