from __future__ import annotations

import logging

from app.core.logging_config import configure_application_logging


def test_application_logging_suppresses_http_client_request_urls():
    logger_names = ("httpx", "httpcore", "httpx2", "httpcore2")
    previous_levels = {
        logger_name: logging.getLogger(logger_name).level for logger_name in logger_names
    }
    try:
        for logger_name in logger_names:
            logging.getLogger(logger_name).setLevel(logging.INFO)

        configure_application_logging()

        assert all(
            logging.getLogger(logger_name).level == logging.WARNING for logger_name in logger_names
        )
    finally:
        for logger_name, level in previous_levels.items():
            logging.getLogger(logger_name).setLevel(level)
