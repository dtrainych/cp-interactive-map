# Stage 1: Build Vue.js app
FROM node:23 as build

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY . .

# Pass the environment variable to the build
ARG VITE_API_URL
ARG VITE_WEBSITE_ID
ARG VITE_ANALYTICS_URL

# Run the build command
RUN npm run build

# Stage 2: Serve the Vue.js app with nginx
FROM nginx:alpine

# Copy the build files to the nginx server
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Expose port 80 for the Vue.js app
EXPOSE 80
