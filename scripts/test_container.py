"""Validate the installed image behind real Caddy TLS, with disposable volumes."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import time

import httpx
from load_test_sync import exercise, IDENTITY, SECRET, TEST_KEY

ROOT = Path(__file__).resolve().parents[1]


def command(arguments: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(arguments, check=True, capture_output=True, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='livemitschrift:test')
    parser.add_argument('--viewers', type=int, default=50)
    parser.add_argument('--duration', type=float, default=10)
    args = parser.parse_args()
    project = 'livemitschrift-test-' + str(os.getpid())
    root = ROOT/'.tools'; root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='container-', dir=root) as temporary:
        directory = Path(temporary)
        command([os.sys.executable, str(ROOT/'scripts/prepare_deployment.py'), str(directory)])
        key = directory/'secrets/publisher.key'; key.chmod(0o600); key.write_text('d'*64+'\n'); key.chmod(0o444)
        with socket.socket() as address:
            address.bind(('127.0.0.1',0)); port = address.getsockname()[1]
        # Use a private CA without modifying the Mac/system trust store.
        original = (directory/'Caddyfile').read_text()
        (directory/'Caddyfile').write_text(original.replace('{$DOMAIN} {','{$DOMAIN} {\n    tls internal'))
        (directory/'test.yaml').write_text(f'''services:
  backend:
    environment:
      LIVEMITSCHRIFT_PUBLIC_URL: https://localhost:{port}
  caddy:
    ports: !override
      - "127.0.0.1:{port}:443"
''')
        env = {**os.environ, 'DOMAIN':'localhost', 'ACME_EMAIL':'test@example.org', 'LIVEMITSCHRIFT_IMAGE':args.image}
        compose = ['docker','compose','--project-name',project,'--project-directory',str(directory),'-f',str(directory/'compose.yaml'),'-f',str(directory/'test.yaml')]
        try:
            command([*compose,'up','-d','--wait','--wait-timeout','90'], env=env)
            backend = command([*compose,'ps','-q','backend'], env=env).stdout.decode().strip()
            caddy = command([*compose,'ps','-q','caddy'], env=env).stdout.decode().strip()
            certificate = directory/'root.crt'
            for attempt in range(40):
                result = subprocess.run(['docker','cp',f'{caddy}:/data/caddy/pki/authorities/local/root.crt',str(certificate)],capture_output=True)
                if result.returncode == 0: break
                time.sleep(.25)
            context = ssl.create_default_context(cafile=str(certificate))
            base = f'https://localhost:{port}'
            with httpx.Client(verify=context, trust_env=False) as client:
                assert client.get(base+'/health').json()=={'status':'ok'}
                assert client.get(base+'/').status_code==200
                for path in ('/build/notebook-viewer.js', '/build/follow-position.js', '/core/index.js',
                             '/pdf/index.js', '/ui/index.js', '/ui/style.css', '/pdfjs/pdf.min.mjs',
                             '/pdfjs/pdf.worker.min.mjs'):
                    response = client.get(base+path)
                    assert response.status_code==200 and response.content, f'Missing viewer asset: {path}'
                assert client.get(base+'/health',headers={'Host':'attacker.example'}).status_code in (400,404,421)
                assert client.get(base+'/health',headers={'Origin':'https://attacker.example'}).status_code==403
                assert client.post(base+'/api/sync/pdf/'+'a'*64,content=b'%PDF-').status_code==401
            inspect = json.loads(command(['docker','inspect',backend]).stdout)[0]
            assert inspect['Config']['User']=='10001:10001'
            assert inspect['HostConfig']['ReadonlyRootfs']
            assert not inspect['HostConfig']['PortBindings']
            assert command(['docker','exec',backend,'id','-u']).stdout.strip()==b'10001'
            command(['docker','exec',backend,'sh','-c','test ! -f /app/backend/.env'])
            assert command(['docker','exec',backend,'cat','/app/LICENSE']).stdout==(ROOT/'LICENSE').read_bytes()
            database = directory/'confirmed.sqlite3'
            async def fetch_database() -> None:
                def backup() -> None:
                    data = command(['docker','exec',backend,'python','-m','app.maintenance','backup']).stdout
                    database.write_bytes(data)
                await asyncio.to_thread(backup)
            report = asyncio.run(exercise(base, 0, 'mixed', args.viewers, args.duration, database,
                                          ROOT/'tmp/pdfs/livemitschrift-two-pages.pdf', ssl_context=context,
                                          prepare_verification=fetch_database))
            logs = command([*compose, 'logs', '--no-color'], env=env).stdout.decode()
            assert all(secret not in logs for secret in (IDENTITY, SECRET, TEST_KEY)), 'Container logs exposed a capability or publisher key.'
            # Prove stopped-server restore using the snapshot taken during live load.
            running = subprocess.run([*compose, 'exec', '-T', 'backend', 'python', '-m', 'app.maintenance', 'restore', '--replace'],
                                     env=env, input=b'', capture_output=True)
            assert running.returncode != 0 and b'Stop the backend' in running.stderr
            command([*compose, 'stop', 'backend'], env=env)
            command([*compose, 'run', '--rm', '--no-deps', '-T', 'backend', 'python', '-m', 'app.maintenance', 'restore', '--replace'],
                    env=env, input=database.read_bytes())
            command([*compose, 'up', '-d', '--wait', '--wait-timeout', '90'], env=env)
            with httpx.Client(verify=context, trust_env=False) as client:
                assert client.get(base+'/health').status_code == 200
                assert client.get(base+'/notebook/'+IDENTITY).status_code == 200
            report['installed_checks'] = ['real Caddy HTTPS/WSS', 'viewer modules and PDF worker', 'bundled AGPL v3 license', 'private backend port', 'unprivileged UID 10001', 'read-only root filesystem', 'no embedded .env', 'redacted capability/key logs', 'host/origin/writer-key checks', 'consistent live SQLite backup and stopped-server restore']
            output = ROOT/'output/load-test/container.json'; output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2)+'\n')
            print('CONTAINER_PASS real TLS/proxy, isolated data, least-privilege runtime and selected-page load.')
            print(f'CONTAINER_PASS {args.viewers} readers; live p95={report["live_delivery_ms"]["p95"]}ms, p99={report["live_delivery_ms"]["p99"]}ms; reconnect p95={report["reconnect_ms"]["p95"]}ms')
        except BaseException:
            logs = subprocess.run([*compose,'logs','--no-color','--tail','80'], env=env, capture_output=True,text=True)
            (ROOT/'output').mkdir(exist_ok=True)
            (ROOT/'output/container-failure.log').write_text(logs.stdout+logs.stderr)
            raise
        finally:
            subprocess.run([*compose,'down','--volumes','--remove-orphans'], env=env, capture_output=True,timeout=30)


if __name__ == '__main__': main()
