# syntax=docker/dockerfile:1.7

FROM python:3.14-slim AS runtime

ARG APP_UID=1000
ARG APP_GID=1000

ENV PATH="/app/backend/.venv/bin:/usr/local/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/backend/.venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --shell /usr/sbin/nologin app

WORKDIR /app/backend

COPY backend/pyproject.toml backend/uv.lock backend/alembic.ini ./
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=app:app backend/ /app/backend/

RUN mkdir -p /data/files /home/app/.cache/fastembed \
    && chown -R app:app /data /home/app/.cache

USER app

# Kamal requires images to carry the service identity label.
LABEL service="clawdi"

EXPOSE 8000

# Kamal uses Docker health for non-proxied roles. Both the API and channels
# worker serve readiness-aware GET /health on this port.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=8 \
    CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "4", "http://127.0.0.1:8000/health"]

CMD ["python", "-m", "app.runtime_entrypoint"]
