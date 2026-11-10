#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly SERVICE=atlas-fips-preview.service
readonly ROOT=$1 SOURCE=$2 INDEX=$3 BUN=$4 NPM=$5 INSTALLER=$6 SEEDS=$7 STAGING=$8 RELEASE=$9
readonly APP="$ROOT/releases/$RELEASE"
readonly UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
readonly UNIT="$UNIT_DIR/$SERVICE"
readonly ENV_FILE="$ROOT/preview.env"
readonly KEY="$ROOT/state/provider.key"
readonly DESCRIPTOR="$ROOT/state/descriptor.json"

# The service name is deliberately not configurable; no Atlas service operations exist.
[[ "$SERVICE" == atlas-fips-preview.service ]]
[[ -x "$BUN" && -f "$INDEX" && -r "$INDEX" && -f "$SOURCE/packages/hashtree/src/build.ts" ]]
[[ -f "$STAGING/provider.tar.gz" && ! -e "$APP" ]]
systemctl --user show-environment >/dev/null
if [[ -L "$ROOT" || -L "$ROOT/state" || -L "$ENV_FILE" || -L "$KEY" ]]; then
  echo 'Refusing symlinked preview state/configuration paths' >&2
  exit 1
fi
if [[ -f "$ENV_FILE" ]] && ! grep -Fxq "ATLAS_FIPS_KEY_PATH=$KEY" "$ENV_FILE"; then
  echo 'Existing configuration uses another identity path; preserve it manually before deploying' >&2
  exit 1
fi
if [[ -e "$KEY" ]] && [[ ! -f "$KEY" || ! -r "$KEY" ]]; then
  echo 'Existing identity must be a readable regular file' >&2
  exit 1
fi
install -d -m 700 "$ROOT" "$ROOT/state" "$ROOT/releases" "$APP"
mkdir -p "$UNIT_DIR"
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || { echo 'Another preview deployment is running' >&2; exit 1; }
tar -xzf "$STAGING/provider.tar.gz" -C "$APP"
cd "$APP"
if [[ "$INSTALLER" == nix ]]; then
  nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#nodejs --command npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
else
  "$NPM" ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
fi
"$BUN" deploy/validate-provider.ts "$SOURCE" "$INDEX" > "$STAGING/validated.json"

cat > "$STAGING/preview.env" <<EOF
ATLAS_SOURCE_ROOT=$SOURCE
ATLAS_INDEX_PATH=$INDEX
ATLAS_FIPS_KEY_PATH=$KEY
ATLAS_FIPS_DESCRIPTOR_PATH=$DESCRIPTOR
ATLAS_FIPS_SEEDS=$SEEDS
EOF
sed -e "s|@APP@|$APP|g" -e "s|@ROOT@|$ROOT|g" -e "s|@BUN@|$BUN|g" \
  deploy/atlas-fips-preview.service.in > "$STAGING/unit"
[[ ! -f "$UNIT" ]] || cp -p "$UNIT" "$STAGING/old-unit"
[[ ! -f "$ENV_FILE" ]] || cp -p "$ENV_FILE" "$STAGING/old-env"
WAS_ACTIVE=0
systemctl --user is-active --quiet "$SERVICE" && WAS_ACTIVE=1
ACTIVATING=1
rollback() {
  local status=$?
  if [[ "$ACTIVATING" == 1 ]]; then
    echo 'Preview activation failed; restoring its prior unit/configuration' >&2
    if [[ -f "$STAGING/old-unit" ]]; then cp -p "$STAGING/old-unit" "$UNIT"; else rm -f "$UNIT"; fi
    if [[ -f "$STAGING/old-env" ]]; then cp -p "$STAGING/old-env" "$ENV_FILE"; else rm -f "$ENV_FILE"; fi
    systemctl --user daemon-reload
    if [[ "$WAS_ACTIVE" == 1 ]]; then systemctl --user restart "$SERVICE"; else systemctl --user stop "$SERVICE"; fi
  fi
  exit "$status"
}
trap rollback EXIT
install -m 600 "$STAGING/preview.env" "$ENV_FILE"
install -m 644 "$STAGING/unit" "$UNIT"
touch "$STAGING/activation-started"
systemctl --user daemon-reload
systemctl --user restart "$SERVICE"
# Bound readiness by an observed new descriptor, not a fixed startup delay.
for attempt in {1..60}; do
  if systemctl --user is-active --quiet "$SERVICE" && [[ "$DESCRIPTOR" -nt "$STAGING/activation-started" ]]; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then echo 'Preview did not publish a fresh descriptor within 15 seconds' >&2; exit 1; fi
  sleep 0.25
done
"$BUN" -e 'const [expected, path] = process.argv.slice(1); const a = await Bun.file(expected).json(); const b = await Bun.file(path).json(); if (a.root !== b.root || a.bytes !== b.bytes || a.chunkBytes !== b.chunkBytes || !/^(02|03)[a-f0-9]{64}$/.test(b.peerId)) throw Error("Descriptor verification failed"); console.log(JSON.stringify(b));' "$STAGING/validated.json" "$DESCRIPTOR"
systemctl --user enable "$SERVICE"
ACTIVATING=0
systemctl --user show "$SERVICE" -p ActiveState -p SubState -p MainPID -p MemoryCurrent
printf 'Descriptor: %s\n' "$DESCRIPTOR"
