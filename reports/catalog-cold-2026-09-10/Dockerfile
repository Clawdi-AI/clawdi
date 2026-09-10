FROM ghcr.io/astral-sh/uv:0.12.5-python3.14-trixie AS uv
FROM python:3.14.7-slim-bookworm
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
WORKDIR /backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-install-project
ENV PATH="/backend/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
