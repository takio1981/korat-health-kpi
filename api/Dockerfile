FROM node:18-alpine

# Install PM2 globally + mariadb-client + gzip + tzdata (สำคัญ: alpine ไม่มี tzdata default — schedulers จะใช้ UTC)
RUN apk add --no-cache mariadb-client gzip tzdata \
    && npm install -g pm2

# ตั้ง timezone container เป็น Asia/Bangkok (UTC+7)
ENV TZ=Asia/Bangkok
RUN cp /usr/share/zoneinfo/Asia/Bangkok /etc/localtime \
    && echo "Asia/Bangkok" > /etc/timezone

WORKDIR /app

# /backups will be mounted from host via docker-compose volume
RUN mkdir -p /backups && chmod 755 /backups

# Copy pre-installed node_modules (installed on host before docker build)
COPY node_modules/ ./node_modules/

# Copy PM2 ecosystem config and package.json
COPY package.json ecosystem.config.js ./

# Copy pre-built application files (server.js, db.js)
# Prepared by deploy.sh: copies api/server.js + db.js -> api/dist/
COPY dist/ ./dist/

EXPOSE 8830

# Start with PM2 (no-daemon mode for Docker)
CMD ["pm2-runtime", "ecosystem.config.js"]
