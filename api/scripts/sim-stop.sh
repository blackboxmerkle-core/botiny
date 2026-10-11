#!/usr/bin/env bash
# Graceful stop: SIGTERM; bots finish the current call then exit.
cd "$(dirname "$0")/.." && [ -f logs/sim.pid ] && kill -TERM "$(cat logs/sim.pid)" && echo "stop signalled to $(cat logs/sim.pid)" || echo "simulator not running"
