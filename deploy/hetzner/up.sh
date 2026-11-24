#!/bin/sh
# Start the LiveMitschrift server from its newest labelled snapshot on Hetzner
# Cloud, with the kept primary IPs and firewall, then wait for HTTPS health.
# Usage: sh deploy/hetzner/up.sh [--no-update]
. "$(dirname "$0")/common.sh"

UPDATE=1
[ "${1:-}" = "--no-update" ] && UPDATE=0

[ -z "$(server_json)" ] || fail "Server $SERVER_NAME existiert bereits."

SNAPSHOT=$(hcloud image list --type snapshot -l "$LABEL" -o json | jq -r 'sort_by(.created) | last | .id // empty')
[ -n "$SNAPSHOT" ] || fail "Kein Snapshot mit Label $LABEL gefunden."

set -- $(primary_ip ipv4)
[ $# -eq 4 ] || fail "Keine Primary IPv4 mit Label $LABEL gefunden."
IPV4_ID=$1 IPV4=$2
[ "$3" = "-" ] || fail "Primary IPv4 $IPV4 ist bereits einem Server zugewiesen."
IPV6_ID=$(primary_ip ipv6 | cut -d' ' -f1)
DOMAIN=$(domain_for "$IPV4")

FIREWALLS=$(hcloud firewall list -l "$LABEL" -o noheader -o columns=id)
SSH_KEYS=$(hcloud ssh-key list -o noheader -o columns=id)

set -- --name "$SERVER_NAME" --type "$SERVER_TYPE" --image "$SNAPSHOT" --location "$LOCATION" \
    --primary-ipv4 "$IPV4_ID" --label "$LABEL"
[ -n "$IPV6_ID" ] && set -- "$@" --primary-ipv6 "$IPV6_ID"
for id in $FIREWALLS; do set -- "$@" --firewall "$id"; done
for id in $SSH_KEYS; do set -- "$@" --ssh-key "$id"; done

say "Erstelle $SERVER_NAME ($SERVER_TYPE, $LOCATION) aus Snapshot $SNAPSHOT mit IP $IPV4 …"
hcloud server create "$@" >/dev/null || fail "Erstellen fehlgeschlagen. Ist $SERVER_TYPE gerade verfügbar? Alternative: LIVEMITSCHRIFT_SERVER_TYPE=cpx32 (Festplatte ≥ 80 GB)."

# A server created from a snapshot gets new SSH host keys (cloud-init), so the
# old entry for this IP is replaced. Starting the stack explicitly also covers a
# snapshot taken after `docker compose stop`, which Docker would not restart.
if [ -n "$SSH_USER" ]; then
    say "Warte auf SSH und starte die Anwendung …"
    ssh-keygen -R "$IPV4" >/dev/null 2>&1 || true
    i=0
    until remote true >/dev/null 2>&1; do
        i=$((i + 1)); [ $i -lt 30 ] || fail "Keine SSH-Verbindung als $SSH_USER nach 5 Minuten."
        sleep 10
    done
    remote 'cd /opt/livemitschrift && sudo docker compose up -d' >/dev/null 2>&1 || fail "Anwendung konnte nicht gestartet werden."
fi

wait_healthy() {
    say "Warte auf https://$DOMAIN/health …"
    i=0
    until curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; do
        i=$((i + 1)); [ $i -lt 40 ] || fail "Server antwortet nach 7 Minuten nicht per HTTPS."
        sleep 10
    done
}
wait_healthy

if [ "$UPDATE" -eq 1 ] && [ -n "$SSH_USER" ]; then
    say "Spiele Sicherheitsupdates ein …"
    remote 'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq -o Dpkg::Options::=--force-confold full-upgrade >/dev/null' \
        || fail "Updates fehlgeschlagen; der Server läuft aber."
    if remote 'test -f /var/run/reboot-required'; then
        say "Neustart für Kernel-Update …"
        remote 'sudo systemctl reboot' >/dev/null 2>&1 || true
        sleep 30
        wait_healthy
    fi
fi

say "Bereit: https://$DOMAIN  (Server $SERVER_NAME, IP $IPV4)"
