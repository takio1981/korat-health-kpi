module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFilesAfterEach: ['<rootDir>/tests/setup.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  verbose: true,
  forceExit: true,    // ปิด process หลัง test เสร็จ (กัน setInterval ค้าง)
  detectOpenHandles: false,
};
