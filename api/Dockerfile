FROM node:18-alpine

# Install PM2 globally
RUN npm install -g pm2

WORKDIR /app

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
