# Stage 1: Build dependencies
FROM node:18-alpine AS builder
WORKDIR /app
COPY . . 
RUN npm ci && npm run build

# Stage 2: Production image
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
ARG CORS_ORIGIN
ENV CORS_ORIGIN=$CORS_ORIGIN
CMD ["node", "dist/server.js"]