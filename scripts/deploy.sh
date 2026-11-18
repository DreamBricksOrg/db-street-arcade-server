#!/usr/bin/env bash
# Roda NO SERVIDOR (o CI envia por ssh: `ssh host 'bash -s -- /caminho' < scripts/deploy.sh`).
# Atualiza o checkout, reconstrói só o dashboard (mongo/redis e seus volumes não
# são tocados) e espera ficar saudável; se não ficar, volta ao commit anterior.
set -euo pipefail

dir="${1:?uso: deploy.sh <pasta do projeto>}"
cd "$dir"

prev=$(git rev-parse HEAD)
git fetch --prune origin
git reset --hard origin/main # o checkout do servidor só recebe deploy (aguenta histórico reescrito)
new=$(git rev-parse HEAD)
echo "deploy: $prev -> $new"

wait_healthy() {
  for _ in $(seq 1 30); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q dashboard)" 2>/dev/null || echo none)
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  return 1
}

docker compose up -d --build dashboard
if wait_healthy; then
  docker image prune -f >/dev/null # o disco do servidor é pequeno
  echo "deploy ok: $new"
  exit 0
fi

echo "deploy FALHOU (dashboard não ficou saudável); voltando para $prev" >&2
docker compose logs --tail=50 dashboard >&2 || true
git reset --hard "$prev"
docker compose up -d --build dashboard
exit 1
