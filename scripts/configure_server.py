"""Create a private, local publisher configuration without printing credentials."""
import os
from pathlib import Path
import secrets


def main():
    destination=Path(__file__).resolve().parents[1]/'backend/.env'
    try:
        descriptor=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    except FileExistsError:
        raise SystemExit('Die Server-Konfiguration existiert bereits und wurde nicht verändert.')
    with os.fdopen(descriptor,'w') as file:
        file.write(f'LIVEMITSCHRIFT_PUBLISHER_KEY={secrets.token_hex(32)}\n')
        file.flush();os.fsync(file.fileno())
    print(f'Private Server-Konfiguration erstellt: {destination}')
    print('Den Zugangsschlüssel aus dieser Datei einmal in der Dozenten-App unter Teilen eintragen.')


if __name__=='__main__':main()
