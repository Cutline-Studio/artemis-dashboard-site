FROM node:20-alpine
ENV NODE_ENV=production PORT=8080 \
    OPS_SANDBOX_UID=10001 OPS_SANDBOX_GID=10001 OPS_SWEEP_UID=1 \
    OPS_SERVER_UID=1000 OPS_SERVER_GID=1000 OPS_POLICY=allowlist
# util-linux-misc: prlimit (rlimits) + unshare (namespaces, used when the host allows them).
# Dedicated sandbox uid 10001 with no home and no shell login; node binary not executable by it.
RUN apk add --no-cache util-linux-misc \
 && addgroup -S -g 10001 sandbox && adduser -S -D -H -u 10001 -G sandbox -s /sbin/nologin sandbox \
 && chown root:node /usr/local/bin/node && chmod 0750 /usr/local/bin/node
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js launch.js ./
COPY ops ./ops
COPY public ./public
RUN chmod -R a-w /app
# Starts as root ONLY for launch.js; it runs server.js as uid 1000 (node) and
# sandbox commands as uid 10001. Set OPS_TERMINAL=0 to disable the terminal.
EXPOSE 8080
CMD ["node", "launch.js"]
