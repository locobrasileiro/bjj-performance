FROM alpine:3.20 AS ds
RUN apk add --no-cache git
RUN git clone --depth 1 --filter=blob:none --sparse https://github.com/hasaneyldrm/exercises-dataset.git /ds \
 && cd /ds && git sparse-checkout set images videos

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
COPY --from=ds /ds/images /usr/share/nginx/html/media/images
COPY --from=ds /ds/videos /usr/share/nginx/html/media/videos
