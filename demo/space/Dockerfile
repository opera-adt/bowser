# The Bowser demo on a Hugging Face Docker Space: the published image plus the Hawaii cube.
# .github/workflows/demo-space.yml uploads this folder (with run_demo.sh) to the Space.
ARG BOWSER_IMAGE=ghcr.io/opera-adt/bowser:latest
FROM ${BOWSER_IMAGE}
ARG BOWSER_DEMO_URL=https://github.com/opera-adt/bowser/releases/download/demo-data/hawaii_demo.zarr.tar
# The cube goes into the image, so the Space starts without downloading it.
RUN mkdir -p /opt/bowser-demo && curl -fL --retry 3 "${BOWSER_DEMO_URL}" | tar -x -C /opt/bowser-demo
COPY run_demo.sh /app/run_demo.sh
# Spaces run as user 1000 with a read-only image: caches and uploads go to /tmp.
ENV HOME=/tmp BOWSER_DEMO_DIR=/opt/bowser-demo BOWSER_UPLOAD_DIR=/tmp/bowser_uploads PORT=7860
EXPOSE 7860
CMD ["bash", "/app/run_demo.sh"]
