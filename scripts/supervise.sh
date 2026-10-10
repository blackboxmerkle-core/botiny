#!/usr/bin/env bash
# Keeps server + ngrok up. If the ngrok URL changes, rewrites PUBLIC_BASE_URL in .env and restarts the server
# (the simulator re-reads .env every call). Stop: kill $(cat logs/supervise.pid)
cd "$(dirname "$0")/.." ; mkdir -p logs; echo $$ > logs/supervise.pid
L=logs/supervise.log; log(){ echo "$(date -Is) $*" >> $L; }
start_server(){ pkill -f "tsx --env-file=.env src/server.ts"; sleep 1; nohup npm start >> logs/server.log 2>&1 & sleep 6; log "server (re)started"; }
start_ngrok(){ pkill -f "ngrok http 8402"; printf 'version: "3"\nagent:\n  crl_noverify: true\n' > /tmp/ngrok-crl.yml
  nohup /home/box/bin/ngrok http 8402 --config /home/box/.config/ngrok/ngrok.yml,/tmp/ngrok-crl.yml --log=stdout --log-format=logfmt > logs/ngrok.log 2>&1 & sleep 8; log "ngrok (re)started"; }
while true; do
  curl -sf -m 5 localhost:8402/v1/health >/dev/null || start_server
  U=$(curl -s -m 5 localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$U" ] && { start_ngrok; U=$(curl -s -m 5 localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4); }
  CUR=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
  if [ -n "$U" ] && [ "$U" != "$CUR" ]; then sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$U#" .env; log "PUBLIC_BASE_URL $CUR -> $U"; start_server; fi
  sleep 30
done
