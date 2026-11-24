"""Exercise one isolated relay with real WebSocket readers, live ink and PDF HTTP.

Run with .venv/bin/python scripts/load_test_sync.py. No production URL/key is used.
This tests the server protocol; it doesn't launch graphical browser renderers.
"""
import argparse
import asyncio
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import sqlite3
import subprocess
import tempfile
import time
from typing import Any

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from test_support import ROOT, start_server, stop

# Deliberately public fixture capabilities, only valid on the temporary test server.
TEST_KEY = 'd' * 64
SECRET = '1' * 64
IDENTITY = hashlib.sha256(SECRET.encode('ascii')).hexdigest()
HEAD = 'a' * 64
PAGE_COUNT, SEED_STROKES, SEED_POINTS = 12, 80, 100
BATCH_POINTS, CONTACT_HZ, STROKE_SECONDS = 8, 240, .5


def encode(value: Any) -> str:
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def summary(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    def percentile(fraction: float) -> float:
        return round(ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)], 2) if ordered else 0
    return {'count': len(values), 'median': percentile(.5), 'p95': percentile(.95), 'p99': percentile(.99), 'max': round(max(values, default=0), 2)}


@dataclass
class Measurements:
    event_sent: dict[tuple, float] = field(default_factory=dict)
    live_ms: list[float] = field(default_factory=list)
    commit_ms: list[float] = field(default_factory=list)
    join_ms: list[float] = field(default_factory=list)
    reconnect_ms: list[float] = field(default_factory=list)
    schedule_lag_ms: list[float] = field(default_factory=list)
    pdf_ms: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    received_bytes: int = 0
    received_frames: int = 0
    sent_bytes: int = 0
    sent_frames: int = 0
    pdf_bytes: int = 0
    active: int = 0
    peak_readers: int = 0
    unexpected_closures: int = 0
    page_loads: int = 0
    validated_cache_hits: int = 0
    independent_ink_messages: int = 0
    slow_events_by_stroke: dict[str, dict[str, float | int]] = field(default_factory=dict)
    commit_queue_peak: int = 0


class Wire:
    def __init__(self, socket: Any, measurements: Measurements):
        self.socket, self.measurements = socket, measurements
        self.lock = asyncio.Lock()

    async def send(self, value: dict) -> None:
        payload = encode(value)
        frames = [payload] if len(payload) <= 32000 else [encode({'type': 'transfer_start'}), *(encode({'type': 'transfer_chunk', 'text': payload[start:start + 32000]}) for start in range(0, len(payload), 32000)), encode({'type': 'transfer_end'})]
        async with self.lock:
            for text in frames:
                self.measurements.sent_bytes += len(text.encode())
                self.measurements.sent_frames += 1
                await self.socket.send(text)

    async def receive(self) -> dict:
        chunks: list[str] | None = None
        size = 0
        while True:
            text = await self.socket.recv()
            if not isinstance(text, str) or len(text.encode()) > 256000:
                raise AssertionError('Invalid server frame type/size.')
            self.measurements.received_bytes += len(text.encode())
            self.measurements.received_frames += 1
            value = json.loads(text)
            if value['type'] == 'transfer_start':
                assert chunks is None
                chunks = []
            elif value['type'] == 'transfer_chunk':
                assert chunks is not None
                size += len(value['text'].encode()); assert size <= 128000000
                chunks.append(value['text'])
            elif value['type'] == 'transfer_end':
                assert chunks is not None
                return json.loads(''.join(chunks))
            else:
                assert chunks is None
                return value


def fixture() -> dict:
    pages = []
    for number in range(PAGE_COUNT):
        strokes = []
        for order in range(SEED_STROKES):
            points = [{'x': round(100 + index * 8, 3), 'y': round(120 + order * 15 + math.sin(index / 8) * 8, 3), 'pressure': .6} for index in range(SEED_POINTS)]
            strokes.append({'id': f'seed-{number}-{order}', 'order': order, 'color': '#243147', 'width': 3.5, 'complete': True, 'points': points})
        pages.append({'id': f'page-{number}', 'title': f'Page {number + 1}', 'width': 1200, 'height': 6400, 'background': None, 'strokes': strokes, 'nextOrder': SEED_STROKES})
    return {'type': 'notebook', 'notebook': {'id': 'load-book', 'title': 'Synthetic load fixture', 'topics': [{'id': 'load-topic', 'title': 'Lecture', 'pages': pages}]}, 'position': {'pageId': 'page-0', 'y': 0}}


async def seed(base: str, writer: Wire, pdf_path: Path, ssl_context=None) -> tuple[str, int]:
    pdf = pdf_path.read_bytes()
    asset = hashlib.sha256(pdf).hexdigest()
    async with httpx.AsyncClient(timeout=30, trust_env=False, verify=ssl_context or True) as client:
        response = await client.post(f'{base}/api/sync/pdf/{asset}', content=pdf, headers={'Authorization': f'Bearer {SECRET}', 'X-LiveMitschrift-Publisher-Key': TEST_KEY})
        response.raise_for_status()
    state = fixture()
    for index, page in enumerate(state['notebook']['topics'][0]['pages']):
        page['background'] = {'assetId': asset, 'name': 'test-slides.pdf', 'pageNumber': index % 2 + 1, 'width': 960, 'height': 540}
    manifest = json.loads(encode(state))
    for page in manifest['notebook']['topics'][0]['pages']:
        page['strokes'] = []
    await writer.send({'type': 'recover_begin', 'sequence': 0, 'head': HEAD, 'snapshot': manifest})
    for page in state['notebook']['topics'][0]['pages']:
        await writer.send({'type': 'recover_page', 'page': page})
        assert await writer.receive() == {'type': 'page_staged', 'pageId': page['id']}
    await writer.send({'type': 'recover_end'})
    assert await writer.receive() == {'type': 'ack', 'sequence': 0}
    return asset, len(encode(state).encode())


class Reader:
    def __init__(self, index: int, base: str, follow: bool, measurements: Measurements, ssl_context=None):
        self.ssl_context = ssl_context
        self.index, self.base, self.follow, self.m = index, base, follow, measurements
        self.selected = 'page-0' if follow else f'page-{6 + index % 6}'
        self.cache: dict[str, dict] = {}
        self.request = 0
        self.ready = asyncio.Event()
        self.page_ready = False
        self.expected_close = False
        self.error: str | None = None
        self.wire: Wire | None = None
        self.task: asyncio.Task | None = None
        self.heartbeat_task: asyncio.Task | None = None
        self.pings: deque[asyncio.Future] = deque()

    async def open(self, reconnecting: bool = False) -> None:
        started = time.perf_counter(); self.ready.clear(); self.page_ready = False; self.expected_close = False
        socket = await connect(f'{self.base.replace("http", "ws")}/ws/notebook/v2/view/{IDENTITY}', proxy=None, ssl=self.ssl_context, max_size=256000, max_queue=16, open_timeout=30, close_timeout=3)
        self.wire = Wire(socket, self.m)
        self.m.active += 1; self.m.peak_readers = max(self.m.peak_readers, self.m.active)
        self.task = asyncio.create_task(self.receive())
        self.heartbeat_task = asyncio.create_task(self.heartbeat())
        await asyncio.wait_for(self.ready.wait(), 30)
        if self.error: raise AssertionError(self.error)
        (self.m.reconnect_ms if reconnecting else self.m.join_ms).append((time.perf_counter() - started) * 1000)

    async def select(self, page_id: str) -> None:
        self.selected = page_id; self.request += 1; self.page_ready = False
        cached = self.cache.get(page_id)
        await self.wire.send({'type': 'subscribe', 'pageId': page_id, 'request': self.request, 'revision': cached['revision'] if cached else None})

    async def ping(self) -> None:
        future = asyncio.get_running_loop().create_future(); self.pings.append(future)
        await self.wire.send({'type': 'ping'})
        await asyncio.wait_for(future, 15)

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(5)
            await self.ping()

    def ink(self, value: dict) -> None:
        op = value['operation']; sid = op['stroke']['id'] if op['type'] == 'stroke_start' else op['stroke_id']
        key = (sid, op['type'], op['points'][-1]['x'] if op['type'] == 'stroke_points' else None)
        if key in self.m.event_sent:
            latency = (time.perf_counter() - self.m.event_sent[key]) * 1000
            self.m.live_ms.append(latency)
            if latency > 100:
                slow = self.m.slow_events_by_stroke.setdefault(sid, {'count': 0, 'max_ms': 0.0})
                slow['count'] += 1
                slow['max_ms'] = round(max(slow['max_ms'], latency), 2)
        strokes = self.cache[self.selected]['strokes']
        if op['type'] == 'stroke_start':
            assert sid not in strokes
            strokes[sid] = op['stroke']
        elif op['type'] == 'stroke_points':
            assert sid in strokes and not strokes[sid]['complete']
            strokes[sid]['points'].extend(op['points'])
        else:
            assert sid in strokes and not strokes[sid]['complete']
            strokes[sid]['complete'] = True

    async def receive(self) -> None:
        try:
            while True:
                value = await self.wire.receive(); kind = value['type']
                if kind == 'structure':
                    assert all(not p['strokes'] for t in value['notebook']['topics'] for p in t['pages'])
                    await self.select(value['position']['pageId'] if self.follow else self.selected)
                elif kind == 'viewport' and self.follow:
                    if value['position']['pageId'] != self.selected:
                        await self.select(value['position']['pageId'])
                elif kind in ('page', 'page_current'):
                    if value['request'] != self.request: continue
                    if kind == 'page':
                        page = value['page']; assert page['id'] == self.selected
                        assert len({s['id'] for s in page['strokes']}) == len(page['strokes'])
                        self.cache[self.selected] = {'revision': value['revision'], 'strokes': {s['id']: s for s in page['strokes']}}
                        self.m.page_loads += 1
                    else:
                        assert self.cache[self.selected]['revision'] == value['revision']
                        self.m.validated_cache_hits += 1
                    self.page_ready = True; self.ready.set()
                elif kind == 'ink':
                    if not self.follow: self.m.independent_ink_messages += 1
                    if value['pageId'] == self.selected and self.page_ready: self.ink(value)
                elif kind == 'edit':
                    if not self.follow: self.m.independent_ink_messages += 1
                    edit = value['edit']
                    if edit['pageId'] != self.selected or not self.page_ready: continue
                    strokes = self.cache[self.selected]['strokes']
                    for sid in edit['remove']: strokes.pop(sid, None)
                    for stroke in edit['insert']:
                        assert stroke['id'] not in strokes
                        strokes[stroke['id']] = stroke
                elif kind == 'revision' and value['pageId'] == self.selected and self.page_ready:
                    self.cache[self.selected]['revision'] = value['revision']
                elif kind == 'pong':
                    assert self.pings
                    future = self.pings.popleft()
                    if not future.done(): future.set_result(None)
                elif kind not in ('extent', 'source_status', 'viewport', 'revision'):
                    raise AssertionError(f'Unexpected reader message: {kind}')
        except ConnectionClosed as error:
            if not self.expected_close:
                self.m.unexpected_closures += 1
                self.error = f'Reader {self.index} unexpectedly closed: {error}'
        except Exception as error:
            self.error = f'Reader {self.index}: {type(error).__name__}: {error}'
        finally:
            self.m.active -= 1
            if self.error: self.m.errors.append(self.error)
            self.ready.set()

    async def close(self) -> None:
        self.expected_close = True
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            with suppress(asyncio.CancelledError, ConnectionClosed): await self.heartbeat_task
        if self.wire: await self.wire.socket.close()
        if self.task: await self.task
        for future in self.pings:
            if not future.done(): future.cancel()
        self.pings.clear()

    async def reconnect(self) -> None:
        await self.close(); await self.open(reconnecting=True)


async def resource_samples(pid: int, samples: list[tuple[float, float, int]]) -> None:
    while True:
        process = await asyncio.create_subprocess_exec('ps', '-o', 'time=,rss=', '-p', str(pid), stdout=asyncio.subprocess.PIPE)
        output, _ = await process.communicate()
        if process.returncode: return
        clock, rss = output.decode().split()
        cpu = 0.0
        for part in clock.replace('-', ':').split(':'): cpu = cpu * 60 + float(part)
        samples.append((time.perf_counter(), cpu, int(rss) * 1024))
        await asyncio.sleep(.5)


def resources(samples: list[tuple[float, float, int]]) -> dict:
    if len(samples) < 2: return {}
    seconds = samples[-1][0] - samples[0][0]
    cpu = [(b[1] - a[1]) / (b[0] - a[0]) * 100 for a, b in zip(samples, samples[1:])]
    return {'cpu_mean_percent_one_core': round((samples[-1][1] - samples[0][1]) / seconds * 100, 2), 'cpu_samples_percent': summary(cpu), 'rss_peak_mib': round(max(r[2] for r in samples) / 1048576, 2), 'sample_period_seconds': .5}


async def exercise(base: str, pid: int, mode: str, viewers: int, duration: float, database: Path, pdf_path: Path, *, ssl_context=None, prepare_verification=None, max_schedule_p95: float = 100) -> dict:
    m = Measurements(); samples = []; sampler = asyncio.create_task(resource_samples(pid, samples)) if pid > 0 else None
    reader_list: list[Reader] = []; writer_receiver = commit_task = heartbeat = None
    socket = None
    started = time.perf_counter()
    try:
        socket = await connect(f'{base.replace("http", "ws")}/ws/sync/v2/publish', proxy=None, ssl=ssl_context, max_size=256000, close_timeout=3)
        writer = Wire(socket, m)
        await writer.send({'type': 'authenticate', 'key': TEST_KEY}); assert await writer.receive() == {'type': 'authenticated'}
        await writer.send({'type': 'hello', 'secret': SECRET, 'sequence': 0, 'head': HEAD, 'firstPending': None})
        assert (await writer.receive())['recover']
        asset, fixture_size = await seed(base, writer, pdf_path, ssl_context)
        # Startup checkpoint traffic is excluded from reader/writing transfer figures.
        m.received_bytes = m.sent_bytes = m.received_frames = m.sent_frames = 0
        ack_waiters: dict[int, asyncio.Future] = {}
        async def replies() -> None:
            while True:
                value = await writer.receive()
                if value['type'] == 'pong': continue
                assert value['type'] == 'ack' and value['sequence'] in ack_waiters
                ack_waiters.pop(value['sequence']).set_result(None)
        async def keep_writer_alive() -> None:
            while True:
                await asyncio.sleep(5); await writer.send({'type': 'ping'})
        writer_receiver = asyncio.create_task(replies()); heartbeat = asyncio.create_task(keep_writer_alive())
        reader_list = [Reader(index, base, mode == 'follow' or index < math.ceil(viewers * .7), m, ssl_context) for index in range(viewers)]
        await asyncio.gather(*(reader.open() for reader in reader_list))
        assert m.active == viewers
        async with httpx.AsyncClient(limits=httpx.Limits(max_connections=viewers), timeout=30, trust_env=False, verify=ssl_context or True) as client:
            async def pdf_request() -> None:
                began = time.perf_counter()
                response = await client.get(f'{base}/api/notebook/{IDENTITY}/pdf/{asset}/page/2')
                response.raise_for_status(); assert response.content.startswith(b'%PDF-')
                m.pdf_ms.append((time.perf_counter() - began) * 1000); m.pdf_bytes += len(response.content)
            await asyncio.gather(*(pdf_request() for _ in range(viewers)))
        queue: asyncio.Queue = asyncio.Queue()
        async def commits() -> None:
            while True:
                operation = await queue.get()
                try:
                    if operation is None: return
                    sequence = operation['sequence']; ack = asyncio.get_running_loop().create_future()
                    ack_waiters[sequence] = ack; sent = time.perf_counter()
                    await writer.send(operation)
                    await asyncio.wait_for(ack, 30)
                    m.commit_ms.append((time.perf_counter() - sent) * 1000)
                finally: queue.task_done()
        commit_task = asyncio.create_task(commits())
        writing_started = time.perf_counter(); orders = [SEED_STROKES] * PAGE_COUNT; sequence = 0
        async def produce() -> None:
            nonlocal sequence
            count = max(1, int(duration / STROKE_SECONDS))
            for index in range(count):
                target = writing_started + index * STROKE_SECONDS
                await asyncio.sleep(max(0, target - time.perf_counter()))
                page_number = min(2, int(index / max(1, count / 3)))
                page_id = f'page-{page_number}'
                if index == 0 or page_id != f'page-{min(2, int((index - 1) / max(1, count / 3)))}':
                    await writer.send({'type': 'viewport', 'position': {'pageId': page_id, 'y': 1000}})
                sid = f'load-{index}'
                points = [{'x': float(100 + sample * 8), 'y': round(1500 + index % 20 * 12 + math.sin(sample / 8) * 10, 3), 'pressure': .6} for sample in range(81)]
                stroke = {'id': sid, 'order': orders[page_number], 'color': '#243147', 'width': 3.5, 'complete': False, 'points': points[:1]}
                orders[page_number] += 1
                m.event_sent[(sid, 'stroke_start', None)] = time.perf_counter()
                await writer.send({'type': 'ink', 'pageId': page_id, 'operation': {'type': 'stroke_start', 'stroke': stroke}})
                for first in range(1, len(points), BATCH_POINTS):
                    last = min(len(points), first + BATCH_POINTS)
                    due = target + (last - 1) / CONTACT_HZ
                    await asyncio.sleep(max(0, due - time.perf_counter()))
                    m.schedule_lag_ms.append(max(0, time.perf_counter() - due) * 1000)
                    batch = points[first:last]; m.event_sent[(sid, 'stroke_points', batch[-1]['x'])] = time.perf_counter()
                    await writer.send({'type': 'ink', 'pageId': page_id, 'operation': {'type': 'stroke_points', 'stroke_id': sid, 'points': batch}})
                m.event_sent[(sid, 'stroke_end', None)] = time.perf_counter()
                await writer.send({'type': 'ink', 'pageId': page_id, 'operation': {'type': 'stroke_end', 'stroke_id': sid}})
                sequence += 1
                queue.put_nowait({'type': 'commit', 'sequence': sequence, 'head': hashlib.sha256(f'head-{sequence}'.encode()).hexdigest(), 'change': {'type': 'edit', 'edit': {'id': f'edit-{sequence}', 'pageId': page_id, 'height': 6400, 'remove': [], 'insert': [{**stroke, 'points': points, 'complete': True}]}}})
                m.commit_queue_peak = max(m.commit_queue_peak, queue.qsize())
        async def navigate() -> None:
            for number in range(max(1, int(duration / 8))):
                await asyncio.sleep(8)
                await asyncio.gather(*(reader.select(f'page-{6 + (reader.index + number + 1) % 6}') for reader in reader_list if not reader.follow))
        async def reconnect_burst() -> None:
            await asyncio.sleep(duration / 2)
            print(f'  {mode}: reconnecting {viewers} readers during live input', flush=True)
            await asyncio.gather(*(reader.reconnect() for reader in reader_list))
        tasks = [asyncio.create_task(produce())]
        if mode == 'mixed': tasks += [asyncio.create_task(navigate()), asyncio.create_task(reconnect_burst())]
        try:
            await asyncio.wait_for(tasks[0], duration + 30)
            for task in tasks[1:]:
                if task.done(): task.result()
            await asyncio.wait_for(queue.join(), 30)
            assert not writer_receiver.done(), 'Writer connection failed.'
        finally:
            for task in tasks:
                if not task.done(): task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError): await task
        writing_seconds = time.perf_counter() - writing_started
        await asyncio.gather(*(reader.ping() for reader in reader_list))
        def verify() -> None:
            with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
                assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
                assert db.execute('SELECT sequence FROM notebooks').fetchone()[0] == sequence
                assert db.execute('SELECT count(*) FROM commits').fetchone()[0] == sequence
                assert db.execute("SELECT count(*) FROM strokes WHERE stroke_id LIKE 'load-%'").fetchone()[0] == sequence
                expected = {page: {json.loads(row[0])['id']: json.loads(row[0]) for row in db.execute('SELECT data FROM strokes WHERE page_id=?', (page,))} for page in {reader.selected for reader in reader_list}}
                for reader in reader_list:
                    assert reader.page_ready and reader.cache[reader.selected]['strokes'] == expected[reader.selected], f'Reader {reader.index}: geometry differs from durable SQL.'
        if prepare_verification:
            await prepare_verification()
        await asyncio.to_thread(verify)
        assert not m.errors and m.unexpected_closures == 0 and m.independent_ink_messages == 0
        assert len(m.live_ms) >= sequence * 8 * sum(reader.follow for reader in reader_list), "Insufficient live samples were delivered."
        assert sequence / writing_seconds >= (1 / STROKE_SECONDS) * .9, 'Load generator did not sustain its target rate.'
        schedule_p95 = summary(m.schedule_lag_ms)['p95']
        # Guards the generator itself: a lagging source would make delivery numbers look better than they are.
        assert schedule_p95 < max_schedule_p95, f'Source scheduling p95={schedule_p95}ms exceeded {max_schedule_p95}ms; intended contact rate was not sustained.'
        queue.put_nowait(None); await commit_task
        await asyncio.gather(*(reader.close() for reader in reader_list))
        return {'scenario': mode, 'passed': True, 'readers': viewers, 'writer_connections': 1, 'peak_readers': m.peak_readers, 'writing_seconds': round(writing_seconds, 2), 'fixture_pages': PAGE_COUNT, 'fixture_ink_points': PAGE_COUNT * SEED_STROKES * SEED_POINTS, 'fixture_json_bytes': fixture_size, 'written_strokes': sequence, 'written_points': sequence * 81, 'scheduled_contact_hz': CONTACT_HZ, 'actual_strokes_per_second': round(sequence / writing_seconds, 2), 'live_delivery_ms': summary(m.live_ms), 'durable_ack_ms': summary(m.commit_ms), 'initial_join_ms': summary(m.join_ms), 'reconnect_ms': summary(m.reconnect_ms), 'source_schedule_lag_ms': summary(m.schedule_lag_ms), 'concurrent_pdf_get_ms': summary(m.pdf_ms), 'pdf_source_bytes': pdf_path.stat().st_size, 'pdf_response_bytes_total': m.pdf_bytes, 'application_received_bytes': m.received_bytes, 'application_sent_bytes': m.sent_bytes, 'application_received_frames': m.received_frames, 'application_sent_frames': m.sent_frames, 'page_loads': m.page_loads, 'validated_page_cache_hits': m.validated_cache_hits, 'unexpected_closures': m.unexpected_closures, 'independent_ink_messages': m.independent_ink_messages, 'commit_queue_peak': m.commit_queue_peak, 'page_change_strokes': [f'load-{math.ceil(sequence / 3)}', f'load-{math.ceil(sequence * 2 / 3)}'], 'events_over_100ms_by_stroke': m.slow_events_by_stroke, 'resources': resources(samples), 'elapsed_seconds': round(time.perf_counter() - started, 2), 'errors': m.errors}
    finally:
        for task in (writer_receiver, commit_task, heartbeat, sampler):
            if task: task.cancel()
        for task in (writer_receiver, commit_task, heartbeat, sampler):
            if task:
                with suppress(asyncio.CancelledError, ConnectionClosed): await task
        await asyncio.gather(*(reader.close() for reader in reader_list), return_exceptions=True)
        if socket: await socket.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--viewers', type=int, default=50)
    parser.add_argument('--duration', type=float, default=60, help='Seconds of live writing per scenario (default: 60).')
    parser.add_argument('--scenario', choices=('follow', 'mixed', 'all'), default='all')
    parser.add_argument('--pdf', type=Path, default=ROOT / 'tmp/pdfs/livemitschrift-two-pages.pdf', help='A synthetic two-page PDF (max 50 MB); cold concurrent GETs request page 2.')
    parser.add_argument('--output', type=Path, default=ROOT / 'output/load-test/latest.json')
    args = parser.parse_args()
    if not 1 <= args.viewers <= 50 or not 10 <= args.duration <= 600: parser.error('Use 1–50 readers and 10–600 seconds.')
    if not args.pdf.is_file() or args.pdf.stat().st_size > 50000000: parser.error('--pdf must name an existing PDF of at most 50 MB.')
    result = {'tested_at_utc': datetime.now(timezone.utc).isoformat(), 'platform': platform.platform(), 'python': platform.python_version(), 'uvicorn': importlib.metadata.version('uvicorn'), 'websockets': importlib.metadata.version('websockets'), 'compression': 'WebSocket permessage-deflate negotiated by default', 'measurement': 'Loopback, one backend process. JSON UTF-8 byte counts exclude WebSocket/TLS framing and compression. No graphical browser rendering. Synthetic fixtures only.', 'scenarios': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for mode in ('follow', 'mixed') if args.scenario == 'all' else (args.scenario,):
        with tempfile.TemporaryDirectory(prefix='livemitschrift-load-') as temporary:
            directory = Path(temporary); server = None
            with (directory / 'server.log').open('w') as log:
                try:
                    import socket
                    with socket.socket() as address:
                        address.bind(('127.0.0.1', 0)); port = address.getsockname()[1]
                    server = start_server(port, log)
                    print(f'Start {mode}: {args.viewers} readers + 1 writer; {args.duration:g}s live writing', flush=True)
                    report = asyncio.run(exercise(f'http://127.0.0.1:{port}', server.pid, mode, args.viewers, args.duration, directory / 'server/notebooks.sqlite3', args.pdf))
                    result['scenarios'].append(report)
                    print(f'  PASS: live p95 {report["live_delivery_ms"]["p95"]}ms; ACK p95 {report["durable_ack_ms"]["p95"]}ms; RSS {report["resources"].get("rss_peak_mib")}MiB', flush=True)
                except BaseException:
                    # Keep synthetic-only diagnostics; never load the real .env.
                    result['server_failure_log'] = (directory / 'server.log').read_text()[-20000:]
                    args.output.write_text(json.dumps(result, indent=2) + '\n')
                    raise
                finally: stop(server)
            assert 'ERROR' not in (directory / 'server.log').read_text(), 'Server logged an exception.'
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Report: {args.output}', flush=True)


if __name__ == '__main__': main()
