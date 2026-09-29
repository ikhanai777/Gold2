FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build --config web/vite.config.ts
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["npx", "tsx", "server/src/index.ts"]
