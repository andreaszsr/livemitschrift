# Shared settings for up.sh / down.sh (POSIX sh, sourced).
# Resources are found by label, so no IDs are stored here. Optional local
# overrides: ~/.config/livemitschrift/hetzner.env (not part of the repository).
set -eu

CONFIG_FILE=${LIVEMITSCHRIFT_HETZNER_CONFIG:-$HOME/.config/livemitschrift/hetzner.env}
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

LABEL=${LIVEMITSCHRIFT_LABEL:-app=livemitschrift}
SERVER_NAME=${LIVEMITSCHRIFT_SERVER_NAME:-livemitschrift1}
SERVER_TYPE=${LIVEMITSCHRIFT_SERVER_TYPE:-cpx22}
LOCATION=${LIVEMITSCHRIFT_LOCATION:-nbg1}
# Admin user on the server (SSH key login). Empty: skip SSH steps.
SSH_USER=${LIVEMITSCHRIFT_SSH_USER:-}
# Snapshots to keep after a successful new one (1 = only the newest).
KEEP_SNAPSHOTS=${LIVEMITSCHRIFT_KEEP_SNAPSHOTS:-1}

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

for tool in hcloud jq curl ssh; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool ist nicht installiert."
done
hcloud server list -o noheader >/dev/null 2>&1 || fail "hcloud hat keinen gültigen Kontext/Token (hcloud context create …)."

primary_ip() {  # $1 = ipv4|ipv6 → prints "id ip assignee_id auto_delete" or nothing
    hcloud primary-ip list -l "$LABEL" -o json \
        | jq -r --arg type "$1" '.[] | select(.type == $type) | "\(.id) \(.ip) \(.assignee_id // "-") \(.auto_delete)"' | head -n 1
}

# Free sslip.io name for the IPv4 address unless LIVEMITSCHRIFT_DOMAIN is set.
domain_for() { printf '%s' "${LIVEMITSCHRIFT_DOMAIN:-$(printf '%s' "$1" | tr . -).sslip.io}"; }

server_json() { hcloud server list -o json | jq -c --arg name "$SERVER_NAME" '.[] | select(.name == $name)'; }

remote() {  # Run a command as the admin user (host key recorded on first use).
    ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$SSH_USER@$IPV4" "$@"
}
