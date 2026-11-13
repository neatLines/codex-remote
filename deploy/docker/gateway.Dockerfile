ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node deploy/docker/*.mjs ./deploy/docker/
USER node
CMD ["node", "deploy/docker/run-gateway.mjs"]
