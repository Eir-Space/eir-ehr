FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY eir.demo.config.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/public-server.ts"]
