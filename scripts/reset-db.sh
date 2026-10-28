#!/usr/bin/env sh
# Drops the given validators' databases (default: the one .env in the
# project root names, with network/testnet.env loaded first) and runs
# setup-db.sh again, so they come back empty and built from the current
# db/schema.sql; the server fills the registry again at its next boot.
#
# Everything in those databases is lost; that is the point. It is for a
# fresh start after a schema change. WITH (FORCE) disconnects a validator
# that is still running, so stop it first if you want a clean log.
#
#   sudo -u postgres sh scripts/reset-db.sh        # the .env make-keys wrote
#   sudo -u postgres sh scripts/reset-db.sh .env   # the same, named
set -eu

cd "$(dirname "$0")/.."
. scripts/find-psql.sh

if [ "${NODE_ENV:-}" = production ]; then
  echo "Refusing to drop databases with NODE_ENV=production." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- .env
fi

for env_file in "$@"; do
  if [ ! -f "$env_file" ]; then
    echo "$env_file: no such file; nothing to reset." >&2
    exit 1
  fi
  case $env_file in /*) ;; *) env_file="./$env_file" ;; esac

  (
    set -a
    . ./network/testnet.env
    . "$env_file"
    set +a

    : "${PGDATABASE:?PGDATABASE is not set in network/testnet.env or $env_file}"

    env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE \
      "$PSQL" -X -q -v ON_ERROR_STOP=1 -d postgres -v db_name="$PGDATABASE" <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db_name')\gexec
SQL

    echo "$env_file: dropped database '$PGDATABASE'."
  )
done

exec sh scripts/setup-db.sh "$@"
