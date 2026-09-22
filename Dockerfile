FROM node:24-alpine
WORKDIR /app
COPY package.json index.html styles.css app.js theme.js portfolio.js assets.js settings.js server.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
