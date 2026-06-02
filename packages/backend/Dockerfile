# Backend Dockerfile
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

# Set work directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create non-root user
# NOTE: create /app/dbdata BEFORE the chown so the SQLite-DB volume mount point
# exists in the image owned by appuser. Docker initialises a fresh named volume
# from the image dir's ownership/permissions, so this is what lets the non-root
# process create scenerx.db inside the (otherwise root-owned) named volume.
RUN adduser --disabled-password --gecos '' appuser && \
    mkdir -p /app/dbdata && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8080

# Run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-keep-alive", "300"]
