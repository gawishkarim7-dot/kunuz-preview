FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV CHECKOUT_ENABLED=false
ENV CATALOG_APPROVED=false
EXPOSE 3026
CMD ["node", "server/app.js"]
