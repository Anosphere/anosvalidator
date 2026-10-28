#!/usr/bin/env sh
# Prepares PostgreSQL for this validator. Safe to re-run.
#
# For each machine file given (default: .env in the project root, the file
# make-keys wrote) it loads network/testnet.env and then that file, so the
# machine file wins, and
#   1. creates the application role if it is missing and syncs its password,
#   2. creates the validator's database if it is missing,
#   3. applies db/schema.sql (tables, triggers, comments).
#
# Step 3 only adds what is missing; it never changes a table that already
# exists. The validator registry is not applied here: the server applies
# network/testnet.registry.json at boot.
#
# Steps 1 and 2 connect as a superuser over the local unix socket, so run the
# script as an OS user that PostgreSQL trusts. Step 3 connects with the
# loaded PG* settings, as the app role, so the app role owns its tables.
#
#   VM (Debian):   sudo -u postgres sh scripts/setup-db.sh        # the .env make-keys wrote
#                  sudo -u postgres sh scripts/setup-db.sh .env   # the same, named
set -eu

cd "$(dirname "$0")/.."
. scripts/find-psql.sh

if [ "$#" -eq 0 ]; then
  set -- .env
fi

for env_file in "$@"; do
  if [ ! -f "$env_file" ]; then
    echo "$env_file: no such file. Run 'npm run make-keys -- --id <N>' first; it writes .env." >&2
    exit 1
  fi
  case $env_file in /*) ;; *) env_file="./$env_file" ;; esac

  # A subshell, so one file's variables never leak into the next. The shared
  # file first, the machine file second: the same order as npm start.
  (
    set -a
    . ./network/testnet.env
    . "$env_file"
    set +a

    : "${PGDATABASE:?PGDATABASE is not set in network/testnet.env or $env_file}"
    : "${PGUSER:?PGUSER is not set in network/testnet.env or $env_file}"
    : "${PGPASSWORD:?PGPASSWORD is not set in $env_file}"

    # Role and database: as the current OS user over the local socket, so the
    # app's PG* variables are unset for this one call. %I and %L in format()
    # quote identifiers and literals safely.
    env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE \
      "$PSQL" -X -q -v ON_ERROR_STOP=1 -d postgres \
      -v db_name="$PGDATABASE" -v db_user="$PGUSER" -v db_password="$PGPASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'db_user')\gexec

SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'db_user', :'db_password')\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name')\gexec
SQL

    # Schema: as the app role, with the loaded PG* settings.
    "$PSQL" -X -q -v ON_ERROR_STOP=1 -1 -f db/schema.sql

    echo "$env_file: role '$PGUSER' and database '$PGDATABASE' are ready (schema applied; the registry is applied by the server at boot)."
  )
done
