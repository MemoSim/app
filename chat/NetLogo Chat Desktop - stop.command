#!/bin/bash
cd "$(dirname "$0")" || exit 1
./scripts/desktop-dev.sh --stop
sleep 1
