# Information analysis agent/Code/Dockerfile
# Information Analysis Agent
# ver. v0.3.0

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/logs

CMD ["node", "src/index.js"]
