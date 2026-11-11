/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {},
  },
  plugins: [require('./tailwind.dark-theme')],   // โหมดมืด: กฎ .dark ของ utility สีทั้งชุด (ดูคำอธิบายในไฟล์)
}