# Sourced by the other scripts: sets PSQL to a usable psql binary.
# Homebrew's postgresql@NN is keg-only and not on PATH by default.
PSQL="${PSQL:-psql}"
if ! command -v "$PSQL" >/dev/null 2>&1; then
  for candidate in /opt/homebrew/opt/postgresql@*/bin/psql /usr/lib/postgresql/*/bin/psql; do
    if [ -x "$candidate" ]; then
      PSQL="$candidate"
      break
    fi
  done
fi
if ! command -v "$PSQL" >/dev/null 2>&1; then
  echo "psql not found. Set PSQL=/path/to/psql and re-run." >&2
  exit 1
fi
