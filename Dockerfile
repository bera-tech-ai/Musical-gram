# Use an official Nginx image as the base
FROM nginx:alpine

# Set working directory inside the container
WORKDIR /usr/share/nginx/html

# Remove default nginx static files
RUN rm -rf ./*

# Copy your index.html into the container
COPY index.html .

# Expose port 80 to access the website
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
