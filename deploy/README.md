# Deploy

Minimal path to run bowser on one EC2 instance serving a catalog of GeoZarr stores from S3.

## Build the image

CI builds and pushes `ghcr.io/opera-adt/bowser:<version>` (plus `:develop` on `main` and `:latest` on `v*` tags) — see `.github/workflows/ci.yml`. Pull the published image with:

```bash
docker pull ghcr.io/opera-adt/bowser:latest
```

To build locally:

```bash
# Frontend bundle is gitignored; build it first so it gets COPY'd into the image.
npm ci && npm run build

# On Apple Silicon, force linux/amd64 — pyproject.toml's pixi platforms list
# doesn't include linux-aarch64.
docker build --platform linux/amd64 -t bowser:local .
```

The image uses a three-stage pixi build: pixi resolves conda-forge GDAL / rasterio / rioxarray in stage 1, the final `ubuntu:24.04` stage ships only the resolved env and bowser source. No pixi, no python build tools in production.

## Run locally

Single dataset (file path or `s3://`):
```bash
docker run --rm -p 8080:8080 \
    -v /tmp/cube.zarr:/data/cube.zarr:ro \
    bowser:local \
    bowser run --stack-file /data/cube.zarr --port 8080
```

Catalog:
```bash
docker run --rm -p 8080:8080 \
    -v $(pwd)/catalog.toml:/data/catalog.toml:ro \
    -v /tmp:/tmp:ro \
    -e BOWSER_CATALOG_FILE=/data/catalog.toml \
    bowser:local
```

## EC2

Build the catalog and upload:
```bash
bowser register mexico-city \
    --uri s3://bowser-demo-data/mexico_city/cube.zarr \
    --name "Mexico City subsidence (Jun–Aug 2024)" \
    --catalog catalog.toml
aws s3 cp catalog.toml s3://bowser-demo-data/catalog.toml
```

Launch an EC2 instance (Amazon Linux 2023 or Ubuntu 24.04):
- Instance type: `t3.medium` is enough for a demo; `c6i.large` for concurrent viewers.
- IAM instance profile: needs `s3:GetObject` on the data bucket (both the catalog object and the dataset prefixes it references).
- Security group: open port 80 (HTTP). For HTTPS, add Caddy or put an ALB in front.
- User data: `deploy/ec2-bootstrap.sh`, with `IMAGE` and `CATALOG_S3` edited at the top.

First boot takes 1-2 min (docker install + image pull). Check progress:
```bash
ssh ec2-user@<ip> sudo tail -f /var/log/bowser-bootstrap.log
```

Once healthy:
```bash
curl http://<ip>/catalog
```
