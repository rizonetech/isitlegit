#!/usr/bin/env python3
"""Observe lane ownership and native state; never wake, restart or change owners.

Only explicit URGENT/REQUEST id timestamp records support mechanical ACK matching.
Narrative decisions, semantic completion and actual model progress remain unknown.
The caller supplies scheduling; this command creates no timer or native job.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

RECORD = re.compile(r'\b(URGENT|REQUEST)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})):\s*')
ACK = re.compile(r'\bACK\s+([^\s:]+):')
DATE = re.compile(r'\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})')


def timestamp(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.timestamp() if parsed.tzinfo else None
        except ValueError:
            pass
    return None


def text_file(path):
    return path.read_text(encoding='utf-8') if path.exists() else ''


def pending_records(inbox, responses, now):
    acked = set(ACK.findall(responses))
    pending = []
    for number, line in enumerate(inbox.splitlines(), 1):
        match = RECORD.search(line)
        if match and match[2] not in acked:
            sent = timestamp(match[3])
            age = max(0, now - sent) if sent is not None else None
            pending.append(dict(kind=match[1].lower(), id=match[2], line=number,
                                sent_at=sent, age_seconds=age,
                                urgent_overdue=match[1] == 'URGENT' and age is not None and age >= 600))
    return pending


def lane_snapshot(handover, lane, now, native_read):
    row = dict(lane=lane, classification='unknown', errors=[], stale_observation=False)
    state_path = handover / 'codex-continuation' / f'{lane}.json'
    if not state_path.exists():
        row['classification'] = 'unregistered'
        return row
    try:
        state = json.loads(state_path.read_text())
        if not isinstance(state, dict) or state.get('lane') != lane:
            raise ValueError('invalid registry identity')
        row.update(owner_phase=state.get('phase'), session=state.get('session'), generation=state.get('generation'))
        out_path = handover / f'{"coordinator" if lane == "main" else lane}-outbox.md'
        inbox_path = handover / f'{"coordinator" if lane == "main" else lane}-inbox.md'
        outbox = text_file(out_path)
        inbox = text_file(inbox_path)
        waits = [line.strip()[8:].strip() for line in outbox.splitlines() if line.strip().startswith('WAITING:')]
        wait = waits[-1] if waits else None
        row['waiting'] = wait
        resumes = [(i, line) for i, line in enumerate(outbox.splitlines(), 1) if re.search(r'\bResume\b', line, re.I)]
        resume_line, resume_text = resumes[-1] if resumes else (None, '')
        resume_date = DATE.search(resume_text)
        row['resume'] = dict(path=str(out_path), line=resume_line,
                             at=timestamp(resume_date[0]) if resume_date else None)
        row['unacknowledged'] = pending_records(inbox, outbox, now)
        observed = state.get('observed') or {}
        hooks = [timestamp(value) for value in observed.values()]
        hooks = [value for value in hooks if value is not None]
        progress = dict(registry_at=timestamp(state.get('updated_at')), hook_at=max(hooks) if hooks else None,
                        outbox_modified_at=out_path.stat().st_mtime if out_path.exists() else None,
                        activated_at=timestamp(state.get('activated_at')),
                        wake_ack_at=timestamp((state.get('last_ack') or {}).get('at')),
                        pending_wake_at=timestamp((state.get('pending') or {}).get('at')))
        row['progress'] = progress
        row['resumption_evidence'] = 'registry activation and wake ACK timestamps only; no semantic progress proof'
        row['release_evidence'] = 'complete phase is an owner declaration only; release or approval is not inferred from prose'
        native = None
        if state.get('session'):
            try:
                thread = native_read(state['session'])
                native = thread['status']['type']
                row['native_status'] = native
                progress['native_updated_at'] = timestamp(thread.get('updatedAt'))
            except Exception as error:
                row['errors'].append('native_read:' + type(error).__name__)
        else:
            row['errors'].append('registered_owner_has_no_session')
        phase = state.get('phase')
        if phase in {'paused', 'complete'}:
            row['classification'] = phase
        elif native is None:
            row['classification'] = 'unknown'
        elif native == 'systemError':
            row['classification'] = 'native_error'
        elif native == 'active':
            row['classification'] = 'active'
        elif native == 'idle':
            if wait and wait.startswith('time:'):
                due = timestamp(wait[5:].strip())
                row['classification'] = 'time_wait' if due is not None and due > now else 'time_wait_elapsed' if due is not None else 'unknown'
            elif wait and wait.startswith(('stamp ', 'coordinator gate for ', 'operator:')):
                row['classification'] = 'blocked'
            elif wait not in {None, 'none'}:
                row['classification'] = 'unknown'
            else:
                row['classification'] = 'idle'
        elif native == 'notLoaded':
            row['classification'] = 'not_loaded'
        if phase == 'stalled' and phase not in {'paused', 'complete'}:
            row['registry_stalled'] = True
        # Metadata activity is evidence freshness, not proof the task is advancing.
        evidence = [progress[k] for k in ('registry_at', 'hook_at', 'native_updated_at') if progress.get(k) is not None]
        age = max(0, now - max(evidence)) if evidence else None
        threshold = 3600 if native == 'active' else 900
        row['observation_age_seconds'] = age
        row['stale_after_seconds'] = threshold
        row['stale_observation'] = age is not None and age >= threshold and row['classification'] in {'active', 'idle', 'not_loaded', 'time_wait_elapsed'}
        pending_at = progress['pending_wake_at']
        row['pending_wake_overdue'] = pending_at is not None and now - pending_at >= 600
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        row['errors'].append('snapshot:' + type(error).__name__)
    return row


def snapshot(handover, lanes, now, native_read):
    # Include owners not yet reflected in the assignment map, excluding timer metadata.
    names = set(lanes)
    for path in (handover / 'codex-continuation').glob('*.json'):
        if path.stem in {'heartbeat'} or path.stem.endswith('-runtime-evidence'):
            continue
        names.add(path.stem)
    rows = [lane_snapshot(handover, lane, now, native_read) for lane in sorted(names)]
    coordinator_inbox = text_file(handover / 'coordinator-inbox.md')
    coordinator_outbox = text_file(handover / 'coordinator-outbox.md')
    return dict(schema_version=1, observed_at=now, lanes=rows,
                coordinator_unacknowledged=pending_records(coordinator_inbox, coordinator_outbox, now),
                request_detection_limit='Only explicit REQUEST/URGENT IDs and exact ACK IDs matched; narrative requests and semantic resolution not inferred.',
                errors=[dict(lane=row['lane'], errors=row['errors']) for row in rows if row['errors']])


def atomic(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.' + path.name, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(handover, report):
    # JSON is authoritative. Both files carry the same observation timestamp.
    lines = [f"Lane health observed_at={report['observed_at']}"]
    for row in report['lanes']:
        flags = []
        if row['stale_observation']: flags.append('stale observation')
        if row['errors']: flags.append('observation error')
        if row.get('unacknowledged'): flags.append(f"unacknowledged IDs={len(row['unacknowledged'])}")
        lines.append(f"{row['lane']}: {row['classification']}; owner={row.get('owner_phase', 'unknown')}; native={row.get('native_status', 'unknown')}" + ('; ' + ', '.join(flags) if flags else ''))
    lines.append(report['request_detection_limit'])
    atomic(handover / 'lane-health.json', json.dumps(report, indent=2) + '\n')
    atomic(handover / 'lane-health.txt', '\n'.join(lines) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--handover-dir', type=Path, default=Path.home() / 'isitlegit-data/handover')
    parser.add_argument('--lanes', type=Path, default=Path(__file__).resolve().parents[1] / 'todo/lanes.json')
    args = parser.parse_args(argv)
    try:
        from codex_rpc import Client
        lanes = json.loads(args.lanes.read_text())['lanes']
        def native_read(session):
            with Client(timeout=3) as client:
                return client.call('thread/read', {'threadId': session, 'includeTurns': False})['thread']
        report = snapshot(args.handover_dir, lanes, time.time(), native_read)
        publish(args.handover_dir, report)
        print(f"lane-health: {len(report['lanes'])} lanes; observation errors={len(report['errors'])}")
        return 1 if report['errors'] else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('lane-health: snapshot failed: ' + type(error).__name__, file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
