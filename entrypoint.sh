#!/bin/sh
set -e

# バインドマウントされた /app/data はホスト側の所有者になるため、
# root で起動してここで所有者を app に直し、その後 app に降格する。
mkdir -p /app/data/uploads
chown -R app:app /app/data

exec su-exec app "$@"
