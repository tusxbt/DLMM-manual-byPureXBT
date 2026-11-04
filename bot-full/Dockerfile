FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm install --omit=dev=false
COPY . .
RUN npm run build
# .env harus di-mount read-only dengan chmod 600 di host
CMD ["npm", "start"]
