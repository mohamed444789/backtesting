#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo 'ERROR: Install Docker Desktop (macOS/Windows) or Docker Engine + Compose v2 (Linux), then rerun.' >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo 'ERROR: Docker is installed but not running. Start Docker Desktop/Engine.' >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo 'ERROR: Docker Compose v2 is required.' >&2; exit 2; }
mkdir -p data/market data/screenshots data/backups data/logs backups logs
port=$(sed -n 's/^ATLAS_PORT=//p' .env 2>/dev/null|tail -1);port=${port:-8080}
if command -v python3 >/dev/null 2>&1; then
  while ! python3 - "$port" <<'PYPORT'
import socket,sys
s=socket.socket()
try:s.bind(('127.0.0.1',int(sys.argv[1])))
except OSError:sys.exit(1)
finally:s.close()
PYPORT
  do port=$((port+1)); [ "$port" -lt 65536 ] || { echo 'No free port'; exit 3; }; done
fi
printf 'ATLAS_PORT=%s
' "$port" > .env
echo 'Building MH Forex Replay…';docker compose build atlas;docker compose up -d atlas
for i in $(seq 1 60); do if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then echo "Ready: http://localhost:$port";exit 0;fi;sleep 2;done
docker compose logs --tail=100 atlas >&2;echo 'ERROR: health check timed out' >&2;exit 1
