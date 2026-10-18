FROM node:20-alpine AS builder
WORKDIR /app

# Install client dependencies and build React 19 dashboard
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# Production runtime stage (server has zero external npm dependencies)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY server/ ./server/
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["npm", "start"]
