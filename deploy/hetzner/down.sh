#!/bin/sh
# Shut the LiveMitschrift server down cleanly, store a snapshot and delete the
# server; the labelled primary IPs stay. The server is only deleted after the
# new snapshot is available; older snapshots are deleted last.
# Usage: sh deploy/hetzner/down.sh [--yes]
ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1
. "$(dirname "$0")/common.sh"

SERVER=$(server_json)
[ -n "$SERVER" ] || fail "Kein Server $SERVER_NAME gefunden."
SERVER_ID=$(printf '%s' "$SERVER" | jq -r '.id')
IPV4=$(printf '%s' "$SERVER" | jq -r '.public_net.ipv4.ip // empty')

# Deleting a server also deletes primary IPs marked auto_delete; refuse then.
for type in ipv4 ipv6; do
    set -- $(primary_ip "$type")
    [ $# -eq 0 ] || [ "$4" = "false" ] || fail "Primary IP $2 würde mit dem Server gelöscht (auto_delete). Abbruch."
done

if [ "$ASSUME_YES" -eq 0 ]; then
    printf 'Server %s (%s) sichern und löschen? [j/N] ' "$SERVER_NAME" "$IPV4"
    read -r answer
    [ "$answer" = "j" ] || [ "$answer" = "J" ] || { echo "Abgebrochen."; exit 0; }
fi

# A clean OS shutdown stops the containers via the Docker daemon; unlike
# `docker compose stop`, their restart policy then starts them on next boot.
say "Fahre den Server herunter …"
hcloud server shutdown --wait --wait-timeout 3m "$SERVER_ID" >/dev/null 2>&1 || true
if [ "$(hcloud server describe "$SERVER_ID" -o json | jq -r '.status')" != "off" ]; then
    echo "Sauberes Herunterfahren hat nicht gereicht; schalte hart aus."
    hcloud server poweroff "$SERVER_ID" >/dev/null
fi

DESCRIPTION="$SERVER_NAME-$(date +%Y-%m-%d-%H%M)"
say "Erstelle Snapshot $DESCRIPTION (das dauert einige Minuten) …"
hcloud server create-image --type snapshot --description "$DESCRIPTION" --label "$LABEL" "$SERVER_ID" >/dev/null \
    || fail "Snapshot fehlgeschlagen. Der Server wurde NICHT gelöscht (ausgeschaltet)."
NEW=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    NEW=$(hcloud image list --type snapshot -l "$LABEL" -o json | jq -r --arg d "$DESCRIPTION" '.[] | select(.description == $d and .status == "available") | .id' | head -n 1)
    [ -n "$NEW" ] && break
    sleep 10
done
[ -n "$NEW" ] || fail "Neuer Snapshot ist nicht verfügbar. Der Server wurde NICHT gelöscht (ausgeschaltet)."

say "Lösche Server $SERVER_NAME (die IP-Adressen bleiben) …"
hcloud server delete "$SERVER_ID" >/dev/null

# Keep the newest KEEP_SNAPSHOTS snapshots, including the one just created.
DELETE=$(hcloud image list --type snapshot -l "$LABEL" -o json | jq -r --argjson keep "$KEEP_SNAPSHOTS" 'sort_by(.created) | .[:([length - $keep, 0] | max)] | .[].id')
for id in $DELETE; do
    [ "$id" = "$NEW" ] && continue
    say "Lösche älteren Snapshot $id …"
    hcloud image delete "$id" >/dev/null
done

say "Fertig. Verbleibend:"
hcloud image list --type snapshot -l "$LABEL" -o columns=id,description,image_size,created
hcloud primary-ip list -l "$LABEL" -o columns=type,ip,assignee_id
