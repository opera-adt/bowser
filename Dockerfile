# Multi-stage Dockerfile for bowser.
# Uses pixi to get the conda-forge GDAL / rasterio / rioxarray stack, then
# ships the resolved env into a minimal ubuntu production image.

# Stage 1: resolve deps with pixi (cached by pyproject.toml + pixi.lock)
FROM ghcr.io/prefix-dev/pixi:0.65.0 AS install

WORKDIR /app

# `.git` is excluded from the build context (.dockerignore), so setuptools_scm
# cannot read the version from git. The CI workflow passes the real version
# via --build-arg VERSION=...; local builds default to 0.0.0.
ARG VERSION=0.0.0
ENV SETUPTOOLS_SCM_PRETEND_VERSION_FOR_BOWSER_INSAR=${VERSION}

COPY pyproject.toml pixi.lock ./

# Minimal source structure so pixi can resolve the editable workspace
RUN mkdir -p src/bowser && \
    touch src/bowser/__init__.py && \
    printf 'version = "%s"\n__version__ = version\n' "${VERSION}" > src/bowser/_version.py

RUN --mount=type=cache,target=/root/.cache/rattler/cache,sharing=private \
    pixi install -e default

# Stage 2: drop the real source + bake the activation script
FROM install AS build

ARG VERSION=0.0.0
ENV SETUPTOOLS_SCM_PRETEND_VERSION_FOR_BOWSER_INSAR=${VERSION}

COPY src/ /app/src/

# _version.py is gitignored, so the real source tree probably lacks it.
# Re-write it with the build-arg version so the running image reports correctly.
RUN printf 'version = "%s"\n__version__ = version\n' "${VERSION}" > src/bowser/_version.py

RUN pixi shell-hook -e default > /activate.sh && \
    chmod +x /activate.sh

# Stage 3: minimal production image — no pixi, just the resolved env
FROM ubuntu:24.04 AS production

LABEL org.opencontainers.image.title="bowser"
LABEL org.opencontainers.image.description="Web browsing tool for InSAR data"
LABEL org.opencontainers.image.source="https://github.com/opera-adt/bowser"
LABEL org.opencontainers.image.url="https://github.com/opera-adt/bowser"
LABEL org.opencontainers.image.documentation="https://github.com/opera-adt/bowser#readme"
LABEL org.opencontainers.image.licenses="BSD-3-Clause OR Apache-2.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.pixi/envs/default /app/.pixi/envs/default
COPY --from=build /app/src/bowser /app/src/bowser
COPY --from=build /activate.sh /activate.sh

WORKDIR /app
ENV PYTHONPATH=/app/src

RUN printf '#!/bin/bash\nset -e\nsource /activate.sh\nexec "$@"\n' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 8080

# The default CMD expects caller to supply either --stack-file or a catalog
# (via BOWSER_CATALOG_FILE env var set at `docker run` time).
CMD ["bowser", "run", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
