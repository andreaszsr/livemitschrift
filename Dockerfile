# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS viewer
WORKDIR /source
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/pdf/package.json packages/pdf/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY frontend/package.json frontend/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --ignore-scripts
COPY packages packages
COPY frontend frontend
COPY scripts/copy_pdf_assets.mjs scripts/copy_pdf_assets.mjs
RUN npm run build --workspace livemitschrift-frontend

FROM python:3.14-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LIVEMITSCHRIFT_BIND=0.0.0.0 LIVEMITSCHRIFT_SERVER_DIR=/data PYTHONPATH=/app/backend
WORKDIR /app
COPY LICENSE LICENSE
RUN groupadd --gid 10001 livemitschrift && useradd --uid 10001 --gid 10001 --no-create-home livemitschrift && mkdir /data && chown 10001:10001 /data
COPY backend/requirements.lock backend/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r backend/requirements.lock \
    && python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.14/ensurepip
COPY backend/app backend/app
COPY --from=viewer /source/frontend/dist frontend/dist
COPY --from=viewer /source/frontend/index.html /source/frontend/notebook.html frontend/
COPY frontend/icons frontend/icons
COPY --from=viewer /source/packages/core/dist packages/core/dist
COPY --from=viewer /source/packages/pdf/dist packages/pdf/dist
COPY --from=viewer /source/packages/ui/dist packages/ui/dist
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).close()"]
CMD ["python", "-m", "app.server"]
