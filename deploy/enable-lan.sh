#!/usr/bin/env bash
# One-time privileged step for this demo's NixOS server.
# Stage this script, lan.nix and configuration.sha256 together; run through sudo.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo 'Run this prepared installer with sudo.' >&2
  exit 1
fi
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config=/etc/nixos/configuration.nix
module=/etc/nixos/atlas-lan.nix
expected=$(cat "$base/configuration.sha256")
actual=$(sha256sum "$config" | cut -d ' ' -f 1)
if [[ ! $expected =~ ^[a-f0-9]{64}$ || $actual != "$expected" ]]; then
  echo 'NixOS configuration changed since preparation. Stop and prepare a fresh diff.' >&2
  exit 1
fi
if [[ -e $module ]] && ! cmp -s "$base/lan.nix" "$module"; then
  echo 'An unrelated atlas-lan.nix exists; refusing to overwrite it.' >&2
  exit 1
fi
backup=$(mktemp -d /etc/nixos/atlas-lan-backup.XXXXXX)
cp -p "$config" "$backup/configuration.nix"
if [[ -e $module ]]; then cp -p "$module" "$backup/atlas-lan.nix"; fi
candidate="$backup/configuration.new.nix"
if grep -Fq './atlas-lan.nix' "$config"; then
  cp "$config" "$candidate"
else
  # The inspected server uses one single-line imports list. Refuse other shapes.
  if [[ $(grep -Ec '^  imports = \[.* \];$' "$config") != 1 ]]; then
    echo 'Unexpected imports layout; no live configuration was changed.' >&2
    exit 1
  fi
  sed -E 's@^(  imports = \[.*) \];$@\1 ./atlas-lan.nix ];@' "$config" > "$candidate"
fi
echo 'Applying only this configuration diff and the Atlas LAN firewall module:'
diff -u "$config" "$candidate" || [[ $? == 1 ]]
cat "$base/lan.nix"
previous_system=$(readlink -f /run/current-system)
modified=0
restore_on_error() {
  local status=$?
  if [[ $status != 0 && $modified == 1 ]]; then
    echo "Activation failed; restoring configuration from $backup" >&2
    cp -p "$backup/configuration.nix" "$config"
    if [[ -e $backup/atlas-lan.nix ]]; then
      cp -p "$backup/atlas-lan.nix" "$module"
    else
      rm -f "$module"
    fi
    "$previous_system/bin/switch-to-configuration" switch || true
  fi
}
trap restore_on_error EXIT
modified=1
install -m 0644 "$base/lan.nix" "$module"
install -m 0644 "$candidate" "$config"
nixos-rebuild switch
modified=0
echo "Atlas port 3100 is now allowed from 192.168.0.0/24 on eno1. Backup: $backup"
