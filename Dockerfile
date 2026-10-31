FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
ENV CHECKOUT_ENABLED=false
ENV CATALOG_APPROVED=false
ENV PORT=7860
EXPOSE 7860
USER node
CMD ["node", "server/app.js"]
