#!/usr/bin/env bash
# Generate the four declared trust-root signing keys for this fixture. Never commit .keys/.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR/.keys"
for k in cap inv wf permit state; do
  [ -f "$DIR/.keys/$k.key" ] || head -c 32 /dev/urandom | base64 > "$DIR/.keys/$k.key"
  chmod 600 "$DIR/.keys/$k.key"
done
echo "keys ready in $DIR/.keys (cap, inv, wf, permit, state)"
