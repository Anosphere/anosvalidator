#!/usr/bin/env sh
# Prepares PostgreSQL for one or more validators. Safe to re-run.
#
# For each env file given (default: every .env-validator<N> in the project
# root) it
#   1. creates the application role if it is missing and syncs its password,
#   2. creates the validator's database if it is missing,
#   3. applies db/schema.sql (tables, triggers, comments),
#   4. applies db/validators.sql (the validator registry).
#
# Steps 3 and 4 only add what is missing; they never change a table that
# already exists. After editing db/schema.sql, rebuild the local databases
# with `npm run db:reset`.
#
# Steps 1 and 2 connect as a superuser over the local unix socket, so run the
# script as an OS user that PostgreSQL trusts. Steps 3 and 4 connect with the
# env file's PG* settings, as the app role, so the app role owns its tables.
#
#   local (Homebrew):   npm run db:setup                         # every validator
#                       sh scripts/setup-db.sh .env-validator2   # just one
#   GCE VM (Debian):    sudo -u postgres sh scripts/setup-db.sh .env-validator1
set -eu

cd "$(dirname "$0")/.."
. scripts/find-psql.sh

if [ "$#" -eq 0 ]; then
  set -- .env-validator[0-9]*
  if [ ! -f "$1" ]; then
    echo "No .env-validator<N> file found. Copy .env-validator.example to .env-validator1 and fill it in first." >&2
    exit 1
  fi
fi

for env_file in "$@"; do
  if [ ! -f "$env_file" ]; then
    echo "$env_file: no such file" >&2
    exit 1
  fi
  case $env_file in /*) ;; *) env_file="./$env_file" ;; esac

  # A subshell, so one file's variables never leak into the next.
  (
    set -a
    . "$env_file"
    set +a

    : "${PGDATABASE:?PGDATABASE is not set in $env_file}"
    : "${PGUSER:?PGUSER is not set in $env_file}"
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

    # Schema and registry: as the app role, with the file's PG* settings.
    "$PSQL" -X -q -v ON_ERROR_STOP=1 -1 -f db/schema.sql
    "$PSQL" -X -q -v ON_ERROR_STOP=1 -1 -f db/validators.sql

    echo "$env_file: role '$PGUSER' and database '$PGDATABASE' are ready (schema and validators applied)."
  )
done
