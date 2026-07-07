# ---- build frontend ----
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci || npm install
COPY client/ ./
RUN npm run build

# ---- run server ----
FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
