from __future__ import annotations

import logging

_HTTP_CLIENT_LOGGERS = ("httpx", "httpcore", "httpx2", "httpcore2")


def configure_application_logging() -> None:
    logging.basicConfig(level=logging.INFO)
    # HTTP client INFO records include complete request URLs. Provider URLs can
    # carry routing credentials, so application code logs sanitized failures
    # explicitly instead of emitting the clients' request-level diagnostics.
    for logger_name in _HTTP_CLIENT_LOGGERS:
        logging.getLogger(logger_name).setLevel(logging.WARNING)
