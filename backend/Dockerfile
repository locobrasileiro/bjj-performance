FROM alpine:3.20 AS ds
RUN apk add --no-cache git
RUN git clone --depth 1 --filter=blob:none --sparse https://github.com/hasaneyldrm/exercises-dataset.git /ds \
 && cd /ds && git sparse-checkout set data

FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js slim.mjs ./
COPY --from=ds /ds/data/exercises.json /tmp/exercises.json
RUN node slim.mjs /tmp/exercises.json /app/exercises.slim.json && rm /tmp/exercises.json
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/bjj.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
