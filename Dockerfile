# Production image for Railway (or any Docker host).
FROM node:22-alpine
WORKDIR /app

# install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --no-audit --no-fund

# build the frontend into dist/
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
