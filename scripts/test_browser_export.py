"""Download a real reader PDF in an isolated headless Chrome profile/server."""
import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

import httpx
from pypdf import PdfReader
from websockets.sync.client import connect

from test_support import ROOT, start_server, stop

KEY, SECRET, HEAD = 'd'*64, '7'*64, 'a'*64
NOTE = 'Privatnotiz-7f3a mit Link https://example.org/skript.'


def student_notes(browser, base, identity):
    """Place a private note, reload, open it again; its text must never reach the network."""
    browser.evaluate("document.querySelector('#toolbar [data-action=note]').click();true")
    browser.wait("document.getElementById('paper').dataset.notes==='placing'")
    browser.evaluate("(() => {const p=document.getElementById('paper').getBoundingClientRect(),s=p.width/1200;"
                     "document.getElementById('paper').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:p.left+600*s,clientY:p.top+300*s}));return true;})()")
    browser.wait("document.getElementById('viewer-dialog').open&&!!document.querySelector('#viewer-dialog textarea')")
    browser.evaluate(f"(() => {{const d=document.getElementById('viewer-dialog');d.querySelector('textarea').value={json.dumps(NOTE)};d.querySelector('form').requestSubmit();return true;}})()")
    browser.wait("!document.getElementById('viewer-dialog').open&&document.querySelector('.note-marker')?.textContent==='1'&&document.getElementById('paper').dataset.notes===''")
    assert browser.evaluate("document.getElementById('notice-text').textContent.includes('nur in diesem Browser')")
    browser.call('Page.reload')
    browser.wait("document.getElementById('connection')?.dataset.state==='waiting'&&document.querySelector('.note-marker')?.textContent==='1'")
    position=browser.evaluate("(() => {const m=document.querySelector('.note-marker');return [parseFloat(m.style.left),parseFloat(m.style.top)];})()")
    assert abs(position[0]-50)<0.5 and abs(position[1]-300/6400*100)<0.5, position
    browser.evaluate("document.querySelector('.note-marker').click();true")
    browser.wait("document.querySelector('#viewer-dialog .note-text a')?.href==='https://example.org/skript'&&document.querySelector('#viewer-dialog .note-text a').rel==='noopener noreferrer'")
    browser.evaluate("document.getElementById('viewer-dialog').close();true")
    browser.evaluate("document.getElementById('notice').hidden=true;true")
    # Nothing that left the browser may contain the note: requests, uploads or WebSocket frames.
    sent=[json.dumps(event['params']) for event in browser.events if event['method'] in ('Network.requestWillBeSent','Network.webSocketFrameSent')]
    assert sent and not any('Privatnotiz-7f3a' in item for item in sent), 'A note left the browser.'


class Browser:
    def __init__(self, wire):
        self.wire, self.sequence, self.session, self.events = wire, 0, None, []

    def call(self, method, params=None):
        self.sequence += 1
        request = {'id': self.sequence, 'method': method, 'params': params or {}}
        if self.session:
            request['sessionId'] = self.session
        self.wire.send(json.dumps(request))
        while True:
            message = json.loads(self.wire.recv(timeout=15))
            if 'method' in message:
                self.events.append(message)
            if message.get('id') == self.sequence:
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message.get('result', {})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True,
                                               'awaitPromise': True, 'userGesture': True})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result['result'].get('value')

    def wait(self, expression):
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            if self.evaluate(expression):
                return
            time.sleep(.1)
        detail = self.evaluate("document.getElementById('export-progress')?.textContent")
        raise RuntimeError(f'Browser condition timed out: {expression}; {detail}')


def publish_fixture(base):
    path = ROOT/'tmp/pdfs/livemitschrift-two-pages.pdf'
    data = path.read_bytes(); asset = hashlib.sha256(data).hexdigest()
    source = PdfReader(path); pages = []
    for index, original in enumerate(source.pages):
        end = 5000 if index == 0 else 400
        pages.append({'id': f'page-{index}', 'title': f'Page {index+1}', 'width': 1200,
                      'height': 6400, 'nextOrder': 1,
                      'background': {'assetId': asset, 'name': 'slides.pdf', 'pageNumber': index+1,
                                     'width': float(original.mediabox.width), 'height': float(original.mediabox.height)},
                      'strokes': [{'id': f'ink-{index}', 'order': 0, 'color': '#b44049', 'width': 7,
                                   'complete': True, 'points': [{'x': 100, 'y': 100, 'pressure': .4},
                                                               {'x': 1000, 'y': end, 'pressure': 1}]}]})
    state = {'type': 'notebook', 'notebook': {'id': 'book', 'title': 'Reader test',
             'topics': [{'id': 'topic', 'title': 'Browser Export', 'pages': pages}]},
             'position': {'pageId': 'page-0', 'y': 0}}
    metadata = copy.deepcopy(state)
    for page in metadata['notebook']['topics'][0]['pages']:
        page['strokes'] = []
    with httpx.Client(trust_env=False) as client:
        response = client.post(base+'/api/sync/pdf/'+asset, content=data,
                               headers={'Authorization': 'Bearer '+SECRET, 'X-LiveMitschrift-Publisher-Key': KEY})
        response.raise_for_status()
    with connect(base.replace('http', 'ws')+'/ws/sync/v2/publish', proxy=None) as writer:
        writer.send(json.dumps({'type': 'authenticate', 'key': KEY})); assert json.loads(writer.recv())['type']=='authenticated'
        writer.send(json.dumps({'type': 'hello', 'secret': SECRET, 'sequence': 0, 'head': HEAD, 'firstPending': None}))
        assert json.loads(writer.recv())['recover']
        writer.send(json.dumps({'type': 'recover_begin', 'sequence': 0, 'head': HEAD, 'snapshot': metadata}))
        for page in pages:
            writer.send(json.dumps({'type': 'recover_page', 'page': page})); assert json.loads(writer.recv())['type']=='page_staged'
        writer.send(json.dumps({'type': 'recover_end'})); assert json.loads(writer.recv())['type']=='ack'
    return hashlib.sha256(SECRET.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default=shutil.which('chromium') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    args = parser.parse_args()
    if not Path(args.browser).is_file():
        raise RuntimeError('Provide an installed Chrome/Chromium executable with --browser.')
    with tempfile.TemporaryDirectory(prefix='livemitschrift-browser-export-') as temporary:
        directory=Path(temporary); server=chrome=None
        with socket.socket() as address:
            address.bind(('127.0.0.1',0)); port=address.getsockname()[1]
        with (directory/'server.log').open('w') as server_log, (directory/'chrome.log').open('w') as chrome_log:
            try:
                server=start_server(port,server_log)
                base=f'http://127.0.0.1:{port}'; identity=publish_fixture(base)
                profile=directory/'profile'; downloads=directory/'downloads'; downloads.mkdir()
                chrome=subprocess.Popen([args.browser, '--headless=new', '--remote-debugging-port=0',
                    '--remote-debugging-address=127.0.0.1', f'--user-data-dir={profile}', '--no-first-run',
                    '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
                    '--disable-extensions', 'about:blank'], stdout=chrome_log, stderr=chrome_log)
                active=profile/'DevToolsActivePort'; deadline=time.monotonic()+20
                while not active.exists() and time.monotonic()<deadline:
                    if chrome.poll() is not None: raise RuntimeError('Headless Chrome exited.')
                    time.sleep(.1)
                endpoint=active.read_text().splitlines()
                with connect(f'ws://127.0.0.1:{endpoint[0]}{endpoint[1]}',proxy=None,max_size=8_000_000) as wire:
                    browser=Browser(wire)
                    browser.call('Browser.setDownloadBehavior',{'behavior':'allow','downloadPath':str(downloads)})
                    target=browser.call('Target.createTarget',{'url':'about:blank'})['targetId']
                    browser.session=browser.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
                    browser.call('Network.enable')
                    browser.call('Page.navigate',{'url':base+'/notebook/'+identity})
                    browser.wait("document.getElementById('connection')?.dataset.state==='waiting'&&!!document.querySelector('#toolbar [data-action=export]:not(:disabled)')")
                    before=browser.evaluate("({page:document.querySelector('.page-count').textContent,scroll:document.getElementById('viewport').scrollTop,follow:document.getElementById('follow-return').hidden})")
                    browser.evaluate("document.querySelector('#toolbar [data-action=export]').click();true")
                    browser.wait("!document.getElementById('export-download').hidden")
                    browser.evaluate("document.getElementById('export-download').click();true")
                    file=downloads/'Browser Export.pdf'; deadline=time.monotonic()+15
                    while not file.is_file() and time.monotonic()<deadline: time.sleep(.1)
                    document=PdfReader(file)
                    assert len(document.pages)==4 and document.metadata.title=='Browser Export'
                    assert 'LiveMitschrift' in document.pages[0].extract_text()
                    browser.evaluate("document.getElementById('export-close').click();true")
                    after=browser.evaluate("({page:document.querySelector('.page-count').textContent,scroll:document.getElementById('viewport').scrollTop,follow:document.getElementById('follow-return').hidden})")
                    assert before==after, 'Export changed navigation/Follow.'
                    assert browser.evaluate("fetch('/api/sync/pdf/'+'a'.repeat(64),{method:'POST',body:'%PDF-'}).then(r=>r.status)")==401
                    student_notes(browser, base, identity)
                    # Export again: the note becomes a real PDF comment on its page.
                    browser.evaluate("document.querySelector('#toolbar [data-action=export]').click();true")
                    browser.wait("!document.getElementById('export-options').hidden&&document.getElementById('export-notes').checked&&!document.getElementById('export-notes-print').checked")
                    # Chrome holds back a second automatic download, so read the generated blob instead.
                    browser.evaluate("(() => {const create=URL.createObjectURL;URL.createObjectURL=blob=>{window.__exportBlob=blob;return create(blob);};return true;})()")
                    browser.evaluate("document.getElementById('export-start').click();true")
                    browser.wait("!document.getElementById('export-download').hidden&&!!window.__exportBlob")
                    encoded=browser.evaluate("window.__exportBlob.arrayBuffer().then(b=>{let s='';for(const c of new Uint8Array(b))s+=String.fromCharCode(c);return btoa(s);})")
                    noted=ROOT/'output/pdf/student-notes-export.pdf'; noted.write_bytes(base64.b64decode(encoded))
                    comments=[annotation.get_object() for annotation in PdfReader(noted).pages[0].get('/Annots', [])]
                    assert [(c['/Subtype'], c['/Contents']) for c in comments]==[('/Text', NOTE)], comments
                    browser.evaluate("document.getElementById('export-close').click();true")
                    # Printable text alone (comments off) still lists the note on an extra page.
                    browser.evaluate("document.querySelector('#toolbar [data-action=export]').click();true")
                    browser.wait("!document.getElementById('export-options').hidden")
                    browser.evaluate("window.__exportBlob=null;document.getElementById('export-notes').checked=false;document.getElementById('export-notes-print').checked=true;document.getElementById('export-start').click();true")
                    browser.wait("!document.getElementById('export-download').hidden&&!!window.__exportBlob")
                    encoded=browser.evaluate("window.__exportBlob.arrayBuffer().then(b=>{let s='';for(const c of new Uint8Array(b))s+=String.fromCharCode(c);return btoa(s);})")
                    printed=ROOT/'output/pdf/student-notes-print.pdf'; printed.write_bytes(base64.b64decode(encoded))
                    reader=PdfReader(printed)
                    assert len(reader.pages)==5 and 'Privatnotiz-7f3a' in reader.pages[3].extract_text(), [page.extract_text()[:80] for page in reader.pages]
                    assert not any(page.get('/Annots') for page in reader.pages), 'Comments were exported although switched off.'
                    browser.evaluate("document.getElementById('export-close').click();true")
                    sent=[json.dumps(event['params']) for event in browser.events if event['method'] in ('Network.requestWillBeSent','Network.webSocketFrameSent')]
                    assert not any('Privatnotiz-7f3a' in item for item in sent), 'A note left the browser during export.'
                    # The overview sits next to "Notiz setzen" and deletes after an inline confirmation.
                    browser.evaluate("document.querySelector('#toolbar [data-action=notes]').click();true")
                    browser.wait("document.getElementById('viewer-dialog').open&&document.querySelectorAll('.notes-row').length===1")
                    browser.evaluate("document.querySelector('.notes-delete').click();true")
                    assert browser.evaluate("document.querySelectorAll('.notes-row').length===1&&document.querySelector('.notes-delete').dataset.armed==='true'")
                    browser.evaluate("document.querySelector('.notes-delete').click();true")
                    browser.wait("document.querySelectorAll('.notes-row').length===0&&!document.querySelector('.note-marker')")
                    browser.evaluate("document.getElementById('viewer-dialog').close();true")
                    assert 'Privatnotiz-7f3a' not in (directory/'server.log').read_text()
                    destination=ROOT/'output/pdf/student-browser-export.pdf'; destination.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copyfile(file,destination)
                    print('BROWSER_EXPORT_PASS actual four-page Chrome download, both PDF slides and long ink, unchanged navigation/Follow, no writer credentials; private note survives reload with a safe link, exports as a PDF comment, never reaches the network and is deleted from the overview; instructor disconnected.')
            finally:
                stop(chrome); stop(server)


if __name__=='__main__': main()
