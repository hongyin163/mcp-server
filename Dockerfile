FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p logs
EXPOSE 3002
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
