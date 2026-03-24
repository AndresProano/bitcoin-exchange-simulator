FROM python:3.11-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY miner.py .

# Expose the Flask API port
EXPOSE 5000

# Environment defaults (overridden by docker-compose / runtime)
ENV MINER_ID=miner_1
ENV BITCOIN_RPC_HOST=bitcoin
ENV BITCOIN_RPC_PORT=18443
ENV BITCOIN_RPC_USER=rpcuser
ENV BITCOIN_RPC_PASS=rpcpassword
ENV BACKEND_URL=http://backend:3001

CMD ["python", "-u", "miner.py"]
