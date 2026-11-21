#!/bin/zsh
cd "$(dirname "$0")/dist" || exit 1
echo "Azeroth Commerce Authority: http://localhost:8766"
echo "Для остановки нажми Ctrl+C."
exec python3 -m http.server 8766 --bind 127.0.0.1
