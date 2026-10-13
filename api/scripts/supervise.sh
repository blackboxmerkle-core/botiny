#!/usr/bin/env bash
# Keeps server + ngrok + crawler worker up (SINGLE INSTANCE: flock on logs/supervise.lock). If the ngrok URL changes, rewrites
# PUBLIC_BASE_URL in .env and restarts the server. Stop: kill $(cat logs/supervise.pid)
# Box-only dev env (SAFE_FETCH_ALLOW_CIDRS, BOTINY_BOX_DEV) comes from $BOTINY_BOX_ENV (default /home/box/.botiny/box-dev.env),
# outside the repo/deploy path; it is exported to the children started here and nowhere else. Production must not have it.
cd "$(dirname "$0")/.." ; mkdir -p logs
exec 9>logs/supervise.lock
flock -n 9 || { echo "supervise.sh already running (pid $(cat logs/supervise.pid 2>/dev/null))" >&2; exit 1; }
echo $$ > logs/supervise.pid
L=logs/supervise.log; log(){ echo "$(date -Is) $*" >> $L; }
BOX_ENV=${BOTINY_BOX_ENV:-/home/box/.botiny/box-dev.env}
if [ -f "$BOX_ENV" ]; then
  [ "$(stat -c %a "$BOX_ENV")" = 600 ] || { log "refusing $BOX_ENV: mode must be 0600"; exit 1; }
  set -a; . "$BOX_ENV"; set +a; log "loaded box-only env $BOX_ENV"
fi
# children never inherit the lock fd (9>&-), so a dead supervisor's server/worker can't block a new one
start_server(){ pkill -f "tsx --env-file=.env src/server.ts"; sleep 1; nohup npm start >> logs/server.log 2>&1 9>&- & sleep 6; log "server (re)started"; }
start_ngrok(){ pkill -f "ngrok http 8402"; printf 'version: "3"\nagent:\n  crl_noverify: true\n' > /tmp/ngrok-crl.yml
  nohup /home/box/bin/ngrok http 8402 --config /home/box/.config/ngrok/ngrok.yml,/tmp/ngrok-crl.yml --log=stdout --log-format=logfmt > logs/ngrok.log 2>&1 9>&- & sleep 8; log "ngrok (re)started"; }
# no wrapper subshell: npm is started directly with its own cwd, so the only process named supervise.sh is this loop
start_crawler(){ mkdir -p ../crawler/logs; nohup npm --prefix ../crawler run worker >> ../crawler/logs/worker.log 2>&1 9>&- & log "crawler worker (re)started"; }
while true; do
  pgrep -f "src/worker.ts" >/dev/null || start_crawler
  curl -sf -m 5 localhost:8402/v1/health >/dev/null || start_server
  U=$(curl -s -m 5 localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$U" ] && { start_ngrok; U=$(curl -s -m 5 localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4); }
  CUR=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
  if [ -n "$U" ] && [ "$U" != "$CUR" ]; then sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$U#" .env; log "PUBLIC_BASE_URL $CUR -> $U"; start_server; fi
  sleep 30
done
