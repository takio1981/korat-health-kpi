FROM nginx:alpine

# ลบ default config ของ Nginx
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy pre-built Angular dist (Angular 17+ output: dist/kpi-web/browser/)
COPY dist/kpi-web/browser/ /usr/share/nginx/html/khupskpi/

# แก้ไข permissions ให้ Nginx อ่านได้
RUN chmod -R 755 /usr/share/nginx/html

# แก้ไข API URL ใน main*.js ให้ใช้ relative path แทน localhost
RUN find /usr/share/nginx/html/khupskpi -type f -name "*.js" \
    -exec sed -i 's|http://localhost:3000/api|/khupskpi/api|g' {} + \
    -exec sed -i 's|http://localhost:8830/khupskpi/api|/khupskpi/api|g' {} + && \
    echo "API URL replacement completed."

EXPOSE 8881

CMD ["nginx", "-g", "daemon off;"]
