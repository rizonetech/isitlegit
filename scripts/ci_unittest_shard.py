#!/usr/bin/env python3
"""Run one deterministic whole-module shard of the unchanged unittest discovery suite."""
import argparse
import json
from pathlib import Path
import sys
import time
import unittest


def test_ids(suite):
    return [case.id() for child in suite for case in leaves(child)]


def leaves(item):
    if isinstance(item, unittest.TestSuite):
        for child in item:
            yield from leaves(child)
    else:
        yield item


def partition(suite, count):
    if count < 1:
        raise ValueError('shards must be positive')
    # Discovery supplies one top-level suite per module. Keep each intact, including load_tests and fixture ordering.
    modules = list(suite)
    assignments = [[] for _ in range(count)]
    loads = [0] * count
    for index, module in sorted(enumerate(modules), key=lambda pair: (-pair[1].countTestCases(), pair[0])):
        shard = min(range(count), key=lambda i: (loads[i], i))
        assignments[shard].append((index, module))
        loads[shard] += module.countTestCases()
    return [unittest.TestSuite(module for _, module in sorted(group)) for group in assignments]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', default='tests/scripts')
    parser.add_argument('--shard', type=int, required=True)
    parser.add_argument('--shards', type=int, required=True)
    parser.add_argument('--list', action='store_true', help='collect only; emit exact test identities as JSON')
    args = parser.parse_args(argv)
    if not 1 <= args.shard <= args.shards:
        parser.error('require 1 <= shard <= shards')
    # Match python -m unittest: the invocation directory remains importable beside the discovered tests.
    sys.path.insert(0, str(Path.cwd()))
    loader = unittest.TestLoader()
    try:
        suite = loader.discover(str(Path(args.start).resolve()))
    except (ImportError, OSError) as error:
        print(f'discovery failed: {error}', file=sys.stderr)
        return 2
    if loader.errors:
        print('\n'.join(loader.errors), file=sys.stderr)
        return 2
    if suite.countTestCases() == 0:
        print('discovery found no tests', file=sys.stderr)
        return 2
    selected = partition(suite, args.shards)[args.shard - 1]
    ids = test_ids(selected)
    if args.list:
        print(json.dumps({'shard':args.shard,'shards':args.shards,'total':suite.countTestCases(),'tests':ids}))
        return 0
    print(f'Project shard {args.shard}/{args.shards}: {len(ids)} of {suite.countTestCases()} discovered tests', flush=True)
    began = time.monotonic()
    result = unittest.TextTestRunner(verbosity=2).run(selected)
    print(f'Project shard {args.shard}/{args.shards}: {result.testsRun} run, {len(result.skipped)} skipped, {time.monotonic()-began:.3f}s', flush=True)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
