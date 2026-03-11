FROM node:18-alpine

# ติดตั้ง PM2 globally
RUN npm install -g pm2

WORKDIR /app

# Copy package files และติดตั้ง dependencies (production only)
COPY package*.json ./
RUN npm install --production

# Copy source files (server.js, db.js)
COPY server.js ./
COPY db.js ./

# Copy PM2 ecosystem config
COPY ecosystem.config.js ./

EXPOSE 8830

# Start ด้วย PM2 (no-daemon mode สำหรับ Docker)
CMD ["pm2-runtime", "ecosystem.config.js"]
