#!/usr/bin/env bash
set -Eeuo pipefail;cd "$(dirname "$0")";docker compose stop atlas;echo 'Stopped. Persistent volume retained.'
