#!/bin/sh
# Sets up the worker VM, both servers: the operator guide's steps 4, 6, 7
# and 8, point by point, one line printed per point; then, once the
# registry row is on GitHub, steps 9 and 10; and on every later run step
# 11's pull and restart. Runs on the worker VM as root, over SSH from Cloud
# Shell, after the doorman line has run, since the worker's internet goes
# through the doorman; every value is a flag and nothing is asked:
#
#   curl -fsSLO https://raw.githubusercontent.com/Anosphere/anosvalidator/main/scripts/bootstrap-worker.sh && sudo sh bootstrap-worker.sh --id <N> --home-x25519 <64 hex> --home-mlkem <3136 hex> --signing-key <66 hex>
#
# Safe to run again: every point does what is still missing and answers
# "already" for what is done. The first run stops after printing the
# validator's public key line, "done through step 8: waiting for registry
# row <N>"; once the row is merged, the same line again does steps 9 and
# 10; later runs do step 11. Once a value is in the machine files its flag
# may be left out, so every later run is the same line with nothing after
# bootstrap-worker.sh; a flag that is given must match what is on disk.
# Everything the commands print goes to /var/log/anos-bootstrap.log; the
# screen gets one line per point and a last line: "done..." or "failed at
# step <number> (<name>): see /var/log/anos-bootstrap.log". No private key
# is ever read or printed: the key files are read by each server and by
# show-key as the anos user, which prints the public key only.
set -eu

SCRIPT=bootstrap-worker.sh
LOG=/var/log/anos-bootstrap.log
VALIDATOR=/opt/anos/anossoftware
KEYHOLDER=/opt/anos/keyholdersoftware
METADATA=http://169.254.169.254/computeMetadata/v1
FILL_IN='<fill in>'

# 0. Root first: the log and everything below need it.
if [ "$(id -u)" -ne 0 ]; then
  echo "failed at the argument check: run as root: sudo sh $SCRIPT --id <N> --home-x25519 <64 hex> --home-mlkem <3136 hex> --signing-key <66 hex>" >&2
  exit 1
fi
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND

# The log holds everything a command prints; the screen, kept on fd 3, gets
# only what say() sends it.
touch "$LOG"
chmod 600 "$LOG"
exec 3>&1
exec >>"$LOG" 2>&1
printf '=== %s %s %s ===\n' "$SCRIPT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"

# say LINE: to the screen and to the log.
say() {
  printf '%s\n' "$*" >&3
  printf '%s\n' "$*"
}

# at NUMBER NAME: the guide point being done, for the failure line.
STEP=''
STEP_NAME=''
at() {
  STEP=$1
  STEP_NAME=$2
}

# fail REASON: the reason goes to the log, the run ends, the EXIT trap
# prints the failure line. Never called inside $(...).
fail() {
  printf '%s\n' "$*"
  exit 1
}

# arg_fail REASON: the argument check failed; nothing has been touched.
ARG_FAILED=0
arg_fail() {
  ARG_FAILED=1
  say "failed at the argument check: $*"
  exit 1
}

TMP=''
on_exit() {
  status=$?
  if [ -n "$TMP" ]; then
    rm -rf "$TMP"
  fi
  if [ "$status" -ne 0 ] && [ "$ARG_FAILED" -eq 0 ]; then
    tail -n 5 "$LOG" >&3
    if [ -n "$STEP" ]; then
      say "failed at step $STEP ($STEP_NAME): see $LOG"
    else
      say "failed at the argument check: see $LOG"
    fi
  fi
}
trap on_exit EXIT

# matches VALUE REGEX: the whole value matches the extended regex.
matches() {
  printf '%s\n' "$1" | grep -Eq "$2"
}

# has_line LINES LINE: LINE is one of the lines.
has_line() {
  printf '%s\n' "$1" | grep -Fxq "$2"
}

# metadata PATH: one value from the metadata server; fails on a 404.
metadata() {
  curl -sS -f -H 'Metadata-Flavor: Google' "$METADATA/$1"
}

# env_value FILE NAME: the value of the one line NAME= in FILE, read with
# sed on that line alone; the file is never printed.
env_value() {
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# unfilled VALUE: the line is still the "<fill in>" make-keys wrote.
unfilled() {
  case $1 in
    "\"$FILL_IN\""|"$FILL_IN"|'') return 0 ;;
  esac
  return 1
}

# as_anos COMMAND: through the anos user's login shell, as the guide does.
as_anos() {
  sudo -iu anos bash -c "$1"
}

# git_anos REPO ARGS: a git command in the repo, as its owner, output kept
# clean of a login shell's for capture.
git_anos() {
  repo=$1
  shift
  sudo -u anos git -C "$repo" "$@"
}

# installed PACKAGE: dpkg says so.
installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

# node_is_24: node -v starts with v24.
node_is_24() {
  case $(node -v 2>/dev/null || true) in
    v24.*) return 0 ;;
  esac
  return 1
}

# psql_version: 17.x, from psql --version; empty when psql is missing.
psql_version() {
  psql --version 2>/dev/null | sed 's/^psql (PostgreSQL) //; s/ .*//' || true
}

# unit_log UNIT: the journal of the unit's current run (its systemd
# invocation), so a line from an earlier boot is never read.
unit_log() {
  journalctl "_SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value "$1" || true)" --no-pager -o cat
}

# boot_error UNIT: the line that stopped the unit's current run, if any:
# a registry, genesis, database or KMS failure, or an env.js refusal.
boot_error() {
  unit_log "$1" | grep -E '^(Registry failed|Genesis failed|Could not connect|KMS self-test failed|Error:)' | tail -n 1
}

# wait_unit UNIT PORT SECONDS: up to SECONDS for the unit's /health on PORT
# to answer 200; a boot error in its journal ends the run with that line.
wait_unit() {
  waited=0
  while :; do
    code=$(curl -s -m 5 -o "$TMP/health-$2.json" -w '%{http_code}' "http://127.0.0.1:$2/health" || true)
    if [ "$code" = 200 ]; then
      break
    fi
    error=$(boot_error "$1")
    if [ -n "$error" ]; then
      fail "$error"
    fi
    if [ "$waited" -ge "$3" ]; then
      fail "$1 answers $code on port $2 after $3 seconds (unit $(systemctl is-active "$1" || true)); the last error in its journal: $(journalctl -u "$1" -n 30 --no-pager -o cat | grep -E '^(Registry failed|Genesis failed|Could not connect|KMS self-test failed|Error:)' | tail -n 1)"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# run_db_scripts: the three scripts of the guide's 8.2, as postgres, in
# order; all three are idempotent.
run_db_scripts() {
  sudo -u postgres sh "$VALIDATOR/scripts/setup-db.sh"
  sudo -u postgres sh "$KEYHOLDER/scripts/setup-db.sh"
  sudo -u postgres sh "$KEYHOLDER/scripts/grant-anos-read.sh"
}

# 0. The arguments: named flags, each given once, each checked for shape,
#    then against the machine files and the metadata server, before
#    anything is touched.
ID=''
HOME_X25519=''
HOME_MLKEM=''
SIGNING_KEY=''
SEEN=''
while [ $# -gt 0 ]; do
  case $1 in
    --id|--home-x25519|--home-mlkem|--signing-key) ;;
    *) arg_fail "unknown flag \"$1\"; the flags are --id, --home-x25519, --home-mlkem and --signing-key" ;;
  esac
  [ $# -ge 2 ] || arg_fail "$1 needs a value"
  case " $SEEN " in
    *" $1 "*) arg_fail "$1 given twice" ;;
  esac
  SEEN="$SEEN $1"
  case $1 in
    --id) ID=$2 ;;
    --home-x25519) HOME_X25519=$2 ;;
    --home-mlkem) HOME_MLKEM=$2 ;;
    --signing-key) SIGNING_KEY=$2 ;;
  esac
  shift 2
done
case " $SEEN " in
  *" --id "*) matches "$ID" '^[1-9][0-9]*$' || arg_fail "--id must be a positive integer with no leading zero, got \"$ID\"" ;;
esac
case " $SEEN " in
  *" --home-x25519 "*) matches "$HOME_X25519" '^[0-9a-f]{64}$' || arg_fail "--home-x25519 must be 64 lowercase hex characters (HOME_X25519_PUBLIC_KEY from the keyholder GUI), got ${#HOME_X25519} characters" ;;
esac
case " $SEEN " in
  *" --home-mlkem "*) matches "$HOME_MLKEM" '^[0-9a-f]{3136}$' || arg_fail "--home-mlkem must be 3136 lowercase hex characters (HOME_MLKEM_PUBLIC_KEY from the keyholder GUI), got ${#HOME_MLKEM} characters" ;;
esac
case " $SEEN " in
  *" --signing-key "*) matches "$SIGNING_KEY" '^0[23][0-9a-f]{64}$' || arg_fail "--signing-key must be 66 lowercase hex characters starting 02 or 03 (the KEYHOLDER_PUBLIC_KEY lines from the keyholder GUI), got \"$SIGNING_KEY\"" ;;
esac

# This VM, from the metadata server: its name, no external IP, and the
# project id and zone the KMS key name is assembled from.
VM_NAME=$(metadata instance/name) || arg_fail 'cannot read the metadata server at 169.254.169.254: is this a Compute Engine VM?'
[ "$VM_NAME" = worker ] || arg_fail "this VM is $VM_NAME, not the worker"
VM_EXTERNAL_IP=$(metadata instance/network-interfaces/0/access-configs/0/external-ip || true)
[ -z "$VM_EXTERNAL_IP" ] || arg_fail "this VM has an external IP $VM_EXTERNAL_IP; the worker must have none (step 1)"
PROJECT=$(metadata project/project-id)
ZONE=$(metadata instance/zone)
ZONE=${ZONE##*/}
matches "$ZONE" '^[a-z]+-[a-z0-9]+-[a-z]$' || arg_fail "the metadata server gives the zone as \"$ZONE\", not a zone like us-east1-b"
REGION=${ZONE%-*}

# --id against both machine files; absent, it is read from the validator's.
if [ -f "$VALIDATOR/.env" ]; then
  DISK_ID=$(env_value "$VALIDATOR/.env" VALIDATOR_ID)
else
  DISK_ID=''
fi
if [ -f "$KEYHOLDER/.env" ]; then
  DISK_KEYHOLDER_ID=$(env_value "$KEYHOLDER/.env" KEYHOLDER_ID)
else
  DISK_KEYHOLDER_ID=''
fi
if [ -n "$ID" ]; then
  if [ -n "$DISK_ID" ] && [ "$ID" != "$DISK_ID" ]; then
    arg_fail "--id is $ID, but $VALIDATOR/.env has VALIDATOR_ID=$DISK_ID"
  fi
elif [ -n "$DISK_ID" ]; then
  ID=$DISK_ID
else
  arg_fail "--id is required until $VALIDATOR/.env exists: the validator's id"
fi
if [ -n "$DISK_KEYHOLDER_ID" ] && [ "$ID" != "$DISK_KEYHOLDER_ID" ]; then
  arg_fail "the id is $ID, but $KEYHOLDER/.env has KEYHOLDER_ID=$DISK_KEYHOLDER_ID"
fi
KMS_KEY_NAME="projects/$PROJECT/locations/$REGION/keyRings/anos-testnet/cryptoKeys/keyholder-$ID"

# A GUI value that is given must equal its line where the line is filled.
check_gui() {
  if [ -n "$3" ] && [ -f "$KEYHOLDER/.env" ]; then
    current=$(env_value "$KEYHOLDER/.env" "$1")
    if ! unfilled "$current" && [ "$current" != "$3" ]; then
      arg_fail "$2 is $3, but $KEYHOLDER/.env has $1=$current"
    fi
  fi
}
check_gui HOME_X25519_PUBLIC_KEY --home-x25519 "$HOME_X25519"
check_gui HOME_MLKEM_PUBLIC_KEY --home-mlkem "$HOME_MLKEM"
check_gui KEYHOLDER_PUBLIC_KEY_1 --signing-key "$SIGNING_KEY"
check_gui KEYHOLDER_PUBLIC_KEY_2 --signing-key "$SIGNING_KEY"

TMP=$(mktemp -d)
if [ -d "$VALIDATOR/.git" ]; then
  VALIDATOR_EXISTED=1
else
  VALIDATOR_EXISTED=0
fi
if [ -d "$KEYHOLDER/.git" ]; then
  KEYHOLDER_EXISTED=1
else
  KEYHOLDER_EXISTED=0
fi
# Whether any point of steps 4 to 8 did work in this run, for the done line.
WORK=0

# 4.1 Look first: Debian 13, the clock, the internet through the doorman,
#     the service account's scope. The values go to the log before the
#     checks, so a failed check still shows what was found.
at 4.1 look
DEBIAN=$(cat /etc/debian_version)
SYNCED=$(timedatectl show -p NTPSynchronized --value || true)
INTERNET=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://deb.debian.org/ || true)
SCOPES=$(metadata instance/service-accounts/default/scopes || true)
echo "Debian $DEBIAN; NTPSynchronized $SYNCED; deb.debian.org $INTERNET; scopes: $(printf '%s' "$SCOPES" | tr '\n' ' ')"
case $DEBIAN in
  13|13.*) ;;
  *) fail "this VM runs Debian $DEBIAN; the guide asks for Debian 13" ;;
esac
[ "$INTERNET" = 200 ] || fail "no internet through the doorman (https://deb.debian.org/ answered $INTERNET): run the doorman line first"
if has_line "$SCOPES" https://www.googleapis.com/auth/cloud-platform; then
  SCOPE=present
else
  fail "the worker's service account lacks the cloud-platform scope: run the Cloud Shell line first (step 2, point 8)"
fi
say "4.1 look: Debian $DEBIAN, clock synchronized $SYNCED, internet via doorman $INTERNET, scope cloud-platform $SCOPE"

# 4.2 Packages: PostgreSQL 17 and git from Debian 13, Node 24 from
#     NodeSource.
at 4.2 packages
psql_is_17() {
  case $(psql_version) in
    17.*) return 0 ;;
  esac
  return 1
}
if node_is_24 && psql_is_17 && [ "$(systemctl is-active postgresql || true)" = active ] && installed git; then
  PACKAGES=already
else
  apt-get update
  apt-get install -y postgresql git curl
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$TMP/nodesource-setup.sh"
  bash "$TMP/nodesource-setup.sh"
  apt-get install -y nodejs
  node_is_24 || fail "node is \"$(node -v 2>&1 || true)\" after the install, not v24"
  psql_is_17 || fail "psql is \"$(psql_version)\" after the install, not 17"
  [ "$(systemctl is-active postgresql || true)" = active ] || fail "postgresql is $(systemctl is-active postgresql || true) after the install: systemctl status postgresql"
  PACKAGES=installed
  WORK=1
fi
NODE_V=$(node -v)
PSQL_V=$(psql_version)
PG_STATE=$(systemctl is-active postgresql || true)
say "4.2 packages: node $NODE_V, psql $PSQL_V, postgresql $PG_STATE, git $PACKAGES"

# 6.2 The anos user, its home traversable by postgres, both repos under it
#     as that user, their dependencies.
at 6.2 install
if id anos; then
  USER_LINE='user anos already'
else
  useradd --system --create-home --home-dir /opt/anos --shell /bin/bash anos
  USER_LINE='user anos created'
  WORK=1
fi
chmod 755 /opt/anos
if [ -d "$VALIDATOR/.git" ]; then
  VALIDATOR_CLONE='anossoftware already'
else
  as_anos "git clone https://github.com/Anosphere/anosvalidator.git $VALIDATOR"
  VALIDATOR_CLONE='anossoftware cloned'
  WORK=1
fi
if [ -d "$KEYHOLDER/.git" ]; then
  KEYHOLDER_CLONE='keyholdersoftware already'
else
  as_anos "git clone https://github.com/Anosphere/anoskeyholder.git $KEYHOLDER"
  KEYHOLDER_CLONE='keyholdersoftware cloned'
  WORK=1
fi
NPM_LINE=''
for repo in "$VALIDATOR" "$KEYHOLDER"; do
  if [ -d "$repo/node_modules" ]; then
    NPM_LINE="$NPM_LINE, npm ci already in ${repo##*/}"
  else
    as_anos "cd $repo && npm ci"
    NPM_LINE="$NPM_LINE, npm ci run in ${repo##*/}"
    WORK=1
  fi
done
say "6.2 install: $USER_LINE, /opt/anos 755, $VALIDATOR_CLONE, $KEYHOLDER_CLONE${NPM_LINE}"

# 7.2 Both keys, each made once by its repo's make-keys as anos, which
#     writes the key file (never shown) and .env; when only one of the two
#     exists, make-keys refuses and this point fails with its message.
#     Then the validator's public key, read on every run by show-key as
#     anos.
at 7.2 keys
make_keys() {
  if [ -f "$1/$2.key" ] && [ -f "$1/.env" ]; then
    KEYS_RESULT="$2 already"
  else
    as_anos "cd $1 && npm run make-keys -- --id $ID"
    KEYS_RESULT="$2 made"
    WORK=1
  fi
}
make_keys "$VALIDATOR" validator
VALIDATOR_KEYS=$KEYS_RESULT
make_keys "$KEYHOLDER" keyholder
KEYHOLDER_KEYS=$KEYS_RESULT
PUBLIC_KEY=$(sudo -u anos node "$VALIDATOR/scripts/show-key.js")
matches "$PUBLIC_KEY" '^0[23][0-9a-f]{64}$' || fail "show-key printed \"$PUBLIC_KEY\", not a public key"
say "7.2 keys: $VALIDATOR_KEYS, $KEYHOLDER_KEYS; Validator $ID, public key $PUBLIC_KEY"

# 7.3 The five lines of the keyholder's .env, written in place as anos
#     where still "<fill in>" and the value is known: the KMS key name is
#     assembled from this VM's project and region, the three GUI values
#     come from the flags; the signing key goes onto both
#     KEYHOLDER_PUBLIC_KEY lines. A filled line must agree with the known
#     value.
at 7.3 'keyholder .env'
# fill NAME VALUE LABEL: sets FILL_RESULT to "written", "already" or
# "still <fill in>", and FILLED to 0 when the line is left unfilled.
fill() {
  current=$(env_value "$KEYHOLDER/.env" "$1")
  if unfilled "$current"; then
    if [ -n "$2" ]; then
      sudo -u anos sed -i "s|^$1=.*|$1=$2|" "$KEYHOLDER/.env"
      FILL_RESULT="$3 written"
      WORK=1
    else
      FILL_RESULT="$3 still $FILL_IN"
      FILLED=0
    fi
  elif [ "$current" = "$2" ] || [ -z "$2" ]; then
    FILL_RESULT="$3 already"
    ALREADY=$((ALREADY + 1))
  else
    fail "$1 in $KEYHOLDER/.env is $current, but this VM's project and region give $2"
  fi
}
FILLED=1
ALREADY=0
fill KMS_KEY_NAME "$KMS_KEY_NAME" KMS_KEY_NAME
KMS_LINE=$FILL_RESULT
fill HOME_X25519_PUBLIC_KEY "$HOME_X25519" 'home x25519'
GUI_LINE=$FILL_RESULT
fill HOME_MLKEM_PUBLIC_KEY "$HOME_MLKEM" 'home mlkem'
GUI_LINE="$GUI_LINE, $FILL_RESULT"
fill KEYHOLDER_PUBLIC_KEY_1 "$SIGNING_KEY" 'signing key 1'
GUI_LINE="$GUI_LINE, $FILL_RESULT"
fill KEYHOLDER_PUBLIC_KEY_2 "$SIGNING_KEY" 'signing key 2'
GUI_LINE="$GUI_LINE, $FILL_RESULT"
if [ "$ALREADY" -eq 5 ]; then
  say '7.3 keyholder .env: all five lines already filled'
elif [ "$FILLED" -eq 1 ]; then
  say "7.3 keyholder .env: $KMS_LINE; $GUI_LINE"
else
  say "7.3 keyholder .env: $KMS_LINE; $GUI_LINE (give --home-x25519, --home-mlkem, --signing-key)"
fi

# 8.2 The databases: the three scripts of the guide, as postgres, when the
#     look of 8.1 misses a database or a role.
at 8.2 databases
PG_LOOK=$(sudo -u postgres psql -At -P pager=off -c "select datname from pg_database where datname in ('anos','keyholder')" -c "select rolname from pg_roles where rolname in ('anossoftware','keyholdersoftware','keyholder_reader')")
echo "databases and roles: $(printf '%s' "$PG_LOOK" | tr '\n' ' ')"
db_missing() {
  for name in anos keyholder anossoftware keyholdersoftware keyholder_reader; do
    has_line "$PG_LOOK" "$name" || return 0
  done
  return 1
}
if db_missing; then
  run_db_scripts
  say '8.2 databases: anos and keyholder ready, keyholder_reader granted'
  WORK=1
else
  say '8.2 databases: already'
fi

# 9.1 Pull, for each repo that existed before this run: a new registry row
#     or new software; npm ci when the lock file changed. A pull that
#     cannot fast-forward fails. A change under db/ runs the database
#     scripts again, which are idempotent.
VALIDATOR_MOVED=0
KEYHOLDER_MOVED=0
DB_CHANGED=0
# pull_repo REPO: sets PULL_RESULT and MOVED; a change under db/ sets DB_CHANGED.
pull_repo() {
  old=$(git_anos "$1" rev-parse --short HEAD)
  as_anos "git -C $1 pull --ff-only"
  new=$(git_anos "$1" rev-parse --short HEAD)
  if [ "$old" != "$new" ]; then
    MOVED=1
    changed=$(git_anos "$1" diff --name-only "$old" "$new")
    PULL_RESULT="Fast-forward to $new"
    if has_line "$changed" package-lock.json; then
      as_anos "cd $1 && npm ci"
      PULL_RESULT="$PULL_RESULT, npm ci run"
    fi
    if printf '%s\n' "$changed" | grep -q '^db/'; then
      DB_CHANGED=1
    fi
  else
    MOVED=0
    PULL_RESULT="already up to date ($new)"
  fi
}
if [ "$VALIDATOR_EXISTED" -eq 1 ] || [ "$KEYHOLDER_EXISTED" -eq 1 ]; then
  at 9.1 pull
  PULL_LINE=''
  if [ "$VALIDATOR_EXISTED" -eq 1 ]; then
    pull_repo "$VALIDATOR"
    VALIDATOR_MOVED=$MOVED
    PULL_LINE="anossoftware $PULL_RESULT"
  fi
  if [ "$KEYHOLDER_EXISTED" -eq 1 ]; then
    pull_repo "$KEYHOLDER"
    KEYHOLDER_MOVED=$MOVED
    PULL_LINE="${PULL_LINE:+$PULL_LINE, }keyholdersoftware $PULL_RESULT"
  fi
  say "9.1 pull: $PULL_LINE"
  if [ "$DB_CHANGED" -eq 1 ]; then
    at 8.2 databases
    run_db_scripts
    say '8.2 databases: scripts run again, db/ changed in the pull'
  fi
fi

# 9.1 The registry row: this validator's row must be in the file, active,
#     with the key printed at 7.2. Absent, the run ends here, waiting.
at 9.1 "registry row $ID"
ROW=$(node -e 'const file = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const row = (file.validators || []).find((r) => r.id === Number(process.argv[2])); console.log(row ? ["present", row.active ? "active" : "inactive", String(row.publicKey), String(row.url)].join("|") : "absent");' "$VALIDATOR/network/testnet.registry.json" "$ID")
if [ "$ROW" = absent ]; then
  say "9.1 registry row $ID: absent"
  say "Give us this line for the registry: Validator $ID, public key $PUBLIC_KEY"
  say 'Once the row is on GitHub, run this same command again; no arguments are needed.'
  say "done through step 8: waiting for registry row $ID"
  exit 0
fi
row_ifs=$IFS
IFS='|'
set -- $ROW
IFS=$row_ifs
ROW_ACTIVE=$2
ROW_KEY=$3
ROW_URL=$4
[ "$ROW_ACTIVE" = active ] || fail "registry row $ID is inactive"
[ "$ROW_KEY" = "$PUBLIC_KEY" ] || fail "registry row $ID carries another key: $ROW_KEY; this validator's is $PUBLIC_KEY"
say "9.1 registry row $ID: present, $ROW_URL"

# 10.2 Both unit files, placed when missing or different; the validator
#      enabled and started when not active, restarted when the software
#      changed in this run (the guide's 11.3); then its health and boot
#      lines.
at 10.2 validator
UNITS_CHANGED=0
for unit in anos-validator anos-keyholder; do
  case $unit in
    anos-validator) source=$VALIDATOR/deploy/$unit.service ;;
    anos-keyholder) source=$KEYHOLDER/deploy/$unit.service ;;
  esac
  if ! cmp -s "$source" "/etc/systemd/system/$unit.service"; then
    install -m 0644 "$source" "/etc/systemd/system/$unit.service"
    UNITS_CHANGED=1
  fi
done
if [ "$UNITS_CHANGED" -eq 1 ]; then
  systemctl daemon-reload
fi
if [ "$(systemctl is-active anos-validator || true)" != active ]; then
  systemctl enable --now anos-validator
  VALIDATOR_ACTION=started
  VALIDATOR_POINT=10.2
elif [ "$VALIDATOR_MOVED" -eq 1 ]; then
  systemctl restart anos-validator
  VALIDATOR_ACTION='restarted (software changed)'
  VALIDATOR_POINT=11.3
else
  VALIDATOR_ACTION=active
  VALIDATOR_POINT=10.2
fi
wait_unit anos-validator 3000 30
VALIDATOR_LOG=$(unit_log anos-validator)
WHO_LINE=$(printf '%s\n' "$VALIDATOR_LOG" | grep -E '^Validator [0-9]+, public key ' | tail -n 1)
REGISTRY_LINE=$(printf '%s\n' "$VALIDATOR_LOG" | grep -E '^Registry ' | tail -n 1)
case $REGISTRY_LINE in
  'Registry failed'*) fail "$REGISTRY_LINE" ;;
esac
if [ -z "$REGISTRY_LINE" ] || [ -z "$WHO_LINE" ]; then
  # A validator up for weeks may have its boot lines rotated out of the
  # journal; its health answer carries the same facts.
  parsed=$(node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = h.validator || {}; const r = h.registry || {}; console.log(["Validator " + v.id + ", public key " + v.publicKey, "Registry " + String(r.hash || "").slice(0, 16) + ", " + r.active + " active"].join("|"));' "$TMP/health-3000.json")
  health_ifs=$IFS
  IFS='|'
  set -- $parsed
  IFS=$health_ifs
  WHO_LINE=$1
  REGISTRY_LINE="$2 (from health; the boot lines are no longer in the journal)"
fi
REGISTRY_HASH=${REGISTRY_LINE#Registry }
REGISTRY_HASH=${REGISTRY_HASH%%,*}
REGISTRY_ACTIVE=${REGISTRY_LINE#*, }
REGISTRY_ACTIVE=${REGISTRY_ACTIVE%% active*}
say "$VALIDATOR_POINT validator: $VALIDATOR_ACTION; $WHO_LINE; $REGISTRY_LINE; 3000: 200"

# 10.3 The keyholder, only once all five lines are filled: the same enable
#      or restart, up to ninety seconds for its first KMS round trip.
at 10.3 keyholder
KEYHOLDER_WAITING=0
if [ "$FILLED" -eq 1 ]; then
  if [ "$(systemctl is-active anos-keyholder || true)" != active ]; then
    systemctl enable --now anos-keyholder
    KEYHOLDER_ACTION=started
    KEYHOLDER_POINT=10.3
  elif [ "$KEYHOLDER_MOVED" -eq 1 ]; then
    systemctl restart anos-keyholder
    KEYHOLDER_ACTION='restarted (software changed)'
    KEYHOLDER_POINT=11.3
  else
    KEYHOLDER_ACTION=active
    KEYHOLDER_POINT=10.3
  fi
  wait_unit anos-keyholder 3200 90
  # A keyholder that answers 200 passed its KMS self-test at boot; the
  # line may be rotated out of the journal of a keyholder up for weeks.
  KMS_LINE=$(unit_log anos-keyholder | grep -Fx 'KMS ok' | tail -n 1)
  [ -n "$KMS_LINE" ] || KMS_LINE='KMS ok at boot (the line is no longer in the journal)'
  say "$KEYHOLDER_POINT keyholder: $KEYHOLDER_ACTION; $KMS_LINE; 3200: 200"
else
  KEYHOLDER_WAITING=1
  KEYHOLDER_ACTION=waiting
  say '10.3 keyholder: waiting for the three GUI values'
fi

if [ "$KEYHOLDER_WAITING" -eq 1 ]; then
  say "done: validator $ID up, registry $REGISTRY_HASH, $REGISTRY_ACTIVE active; the keyholder waits for the three GUI values"
elif [ "$WORK" -eq 0 ] && [ "$VALIDATOR_MOVED" -eq 0 ] && [ "$KEYHOLDER_MOVED" -eq 0 ] && [ "$VALIDATOR_ACTION" = active ] && [ "$KEYHOLDER_ACTION" = active ]; then
  say "done: nothing to do; validator $ID on registry $REGISTRY_HASH, $REGISTRY_ACTIVE active; keyholder active"
else
  say "done: validator $ID and keyholder $ID up; registry $REGISTRY_HASH, $REGISTRY_ACTIVE active"
fi
