FROM nginx:alpine

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy pre-built Angular dist
# Prepared by deploy.sh: ng build --base-href /khupskpi/ -> frontend/dist/
COPY dist/ /usr/share/nginx/html/khupskpi/

# Fix permissions
RUN chmod -R 755 /usr/share/nginx/html

EXPOSE 8881

CMD ["nginx", "-g", "daemon off;"]
