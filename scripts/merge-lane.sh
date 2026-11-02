#!/bin/sh
# One command for a lane merge through its plan stop (D00 T01 §23).
# `git merge --no-edit <ref>`; when that merge stopped only at pre-merge-commit
# (the §22 plan stop: its own message in this merge's output, MERGE_HEAD present,
# no unmerged paths), conclude it with `git commit --no-edit`, which validates
# both parents and regenerates the plan in pre-commit. Every other outcome
# (conflict, refusal, fast-forward, already up to date) is git's own, untouched.
set -u

if [ $# -ne 1 ]; then
  echo "usage: scripts/merge-lane.sh <ref>" >&2
  exit 2
fi
case $1 in
  -*)
    echo "merge-lane: '$1' looks like an option, not a ref" >&2
    exit 2
    ;;
esac

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 1
if [ -f "$git_dir/MERGE_HEAD" ]; then
  echo "merge-lane: a merge is already in progress; conclude it with 'git commit --no-edit' or abandon it with 'git merge --abort'" >&2
  exit 1
fi

out=$(git merge --no-edit "$1" 2>&1)
status=$?
printf '%s\n' "$out"
[ $status -eq 0 ] && exit 0

# Conclude only this invocation's plan stop: the hook named itself in this
# merge's output, the merge is still open, and nothing is unmerged.
case $out in
  *"pre-merge-commit: the merge changes the plan's inputs"*)
    if [ -f "$git_dir/MERGE_HEAD" ] && [ -z "$(git diff --name-only --diff-filter=U)" ]; then
      git commit --no-edit
      exit $?
    fi
    ;;
esac
exit $status
