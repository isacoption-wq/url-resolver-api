FROM node:18-alpine

WORKDIR /app

# Instalar curl para healthcheck
RUN apk add --no-cache curl

# Copiar package.json primeiro (cache de layers)
COPY package.json ./

# Instalar dependências
RUN npm install --production

# Copiar código
COPY server.js ./

# Expor porta
EXPOSE 3000

# Rodar aplicação
CMD ["node", "server.js"]
