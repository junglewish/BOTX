FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV BOTX_STORAGE_DIR=/app/runtime

RUN mkdir -p /app/runtime/data /app/runtime/sessions

EXPOSE 3000

CMD ["node", "server.js"]
