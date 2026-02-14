"""Gunicorn configuration for production deployment."""

import os

# Bind to the port Render assigns via $PORT, default to 5000 locally
bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"

# Workers — Render free tier has 512MB RAM, 2 workers is safe
workers = 2

# Threads per worker — needed for background extraction jobs
threads = 4

# Timeout — extraction can be slow, give it room
timeout = 120

# Access logging
accesslog = "-"
loglevel = "info"
