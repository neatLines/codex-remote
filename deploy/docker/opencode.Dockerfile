ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE}
ARG OPENCODE_UID=1002
ARG OPENCODE_GID=1002
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG OPENCODE_SHA256=489b51816a77809e841310e80c88e834c28c19ad1639e12ba8a19f08b47ab607
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl openssh-client ripgrep python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${OPENCODE_GID}" opencode \
    && useradd --uid "${OPENCODE_UID}" --gid opencode --create-home --shell /bin/bash opencode \
    && install -d -o opencode -g opencode /home/opencode/workspaces \
       /home/opencode/.codex /home/opencode/.config/opencode /home/opencode/.local/share/opencode \
       /home/opencode/.local/state/opencode /home/opencode/.cache/opencode \
    && chown -R opencode:opencode /home/opencode
# Named build context contains the existing, verified 2.0.32 Linux x64 binary only.
COPY --from=opencode_binary --chmod=755 /opencode /usr/local/bin/opencode
RUN echo "${OPENCODE_SHA256}  /usr/local/bin/opencode" | sha256sum -c - \
    && test "$(opencode --version)" = 'opencode v2.0.32'
WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY deploy/docker/*.mjs ./deploy/docker/
ENV HOME=/home/opencode PATH=/home/opencode/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
USER opencode
WORKDIR /home/opencode/workspaces
CMD ["node", "/app/deploy/docker/run-opencode.mjs"]
