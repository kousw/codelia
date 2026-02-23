FROM oven/bun:1.3.9

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY packages ./packages
COPY scripts ./scripts
COPY examples/basic-web ./examples/basic-web
COPY tools/terminal-bench ./tools/terminal-bench

RUN bun install --frozen-lockfile

ENTRYPOINT ["bash", "tools/terminal-bench/scripts/run-local.sh"]
