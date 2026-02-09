FROM oven/bun:1.3.8

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json biome.json ./
COPY packages ./packages
COPY examples/basic-web ./examples/basic-web

RUN bun install --frozen-lockfile
RUN bun run --filter '@codelia/*' build

CMD ["bun", "--version"]
