module.exports = {
  apps: [
    {
      name: 'kpi-backend',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 8830,
      },
    },
  ],
};
