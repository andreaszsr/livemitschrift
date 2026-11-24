"""Manage publishing accounts on the server (host administrator only, no web endpoint).

Run inside the container, e.g.:
    docker compose exec backend python -m app.users add mustermann --name "Erika Mustermann"
    docker compose exec backend python -m app.users key-create mustermann --label "MacBook"
"""
import argparse
from datetime import datetime
from pathlib import Path

from .accounts import Accounts
from .page_store import PageStore
from .settings import Settings, server_directory


def when(timestamp: int | None) -> str:
    return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M') if timestamp else '—'


def main(argv: list[str] | None = None, directory: Path | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    add = commands.add_parser('add', help='Freigeschaltete Person anlegen')
    add.add_argument('username'); add.add_argument('--name', help='Anzeigename'); add.add_argument('--admin', action='store_true')
    commands.add_parser('list', help='Personen mit Schlüsseln und Notizbüchern auflisten')
    for name, text in (('disable', 'Person sperren (alle Schlüssel ungültig)'), ('enable', 'Gesperrte Person wieder freigeben'), ('keys', 'Schlüssel einer Person auflisten')):
        commands.add_parser(name, help=text).add_argument('username')
    create = commands.add_parser('key-create', help='Persönlichen Schlüssel erzeugen (wird einmal angezeigt)')
    create.add_argument('username'); create.add_argument('--label', default='Mac')
    revoke = commands.add_parser('key-revoke', help='Schlüssel widerrufen')
    revoke.add_argument('username'); revoke.add_argument('key_id', type=int)
    commands.add_parser('notebooks', help='Notizbücher mit Eigentümern auflisten')
    transfer = commands.add_parser('transfer', help='Notizbuch einer anderen Person übertragen')
    transfer.add_argument('identity', help='Notizbuch-Kennung (mindestens 8 Zeichen)'); transfer.add_argument('username')
    args = parser.parse_args(argv)

    settings = Settings.configured()
    accounts = Accounts(PageStore(directory or server_directory(), max_bytes=settings.max_database_bytes, max_notebooks=settings.max_notebooks))
    try:
        if args.command == 'add':
            accounts.add_user(args.username, args.name, args.admin)
            print(f'Angelegt: {args.username}. Schlüssel erzeugen mit: key-create {args.username}')
        elif args.command == 'list':
            for user in accounts.users():
                state = 'gesperrt' if user['disabled'] else user['role']
                print(f"{user['username']:<20} {user['name']:<28} {state:<9} Schlüssel: {user['keys']}  Notizbücher: {user['notebooks']}")
        elif args.command in ('disable', 'enable'):
            accounts.set_disabled(args.username, args.command == 'disable')
            print('Gesperrt.' if args.command == 'disable' else 'Freigegeben.')
        elif args.command == 'keys':
            for key in accounts.tokens(args.username):
                print(f"#{key['id']:<4} {key['label']:<24} erstellt {when(key['created'])}  zuletzt {when(key['last_used'])}{'  WIDERRUFEN' if key['revoked'] else ''}")
        elif args.command == 'key-create':
            key = accounts.create_token(args.username, args.label)
            print('Persönlicher Zugangsschlüssel (wird nur jetzt angezeigt, sicher übergeben):')
            print(key)
        elif args.command == 'key-revoke':
            accounts.revoke_token(args.username, args.key_id)
            print('Widerrufen. Laufende Verbindungen enden beim nächsten Speichern.')
        elif args.command == 'notebooks':
            for notebook in accounts.notebooks():
                print(f"{notebook['identity'][:12]}  {notebook['owner'] or '(ohne Eigentümer)':<20} {notebook['title']}")
        elif args.command == 'transfer':
            identity = accounts.transfer(args.identity, args.username)
            print(f'{identity[:12]} gehört jetzt {args.username}.')
    except ValueError as error:
        raise SystemExit(f'Fehler: {error}') from None


if __name__ == '__main__':
    main()
