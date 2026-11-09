#!/bin/bash
# Release a commit of `main` to the hosted demo: fast-forward the `demo` branch on GitHub, which
# Render deploys (render.yaml `branch: demo`). Pushes to `main` deploy only the home server
# (scripts/server-deploy.sh); nothing reaches the demo until it is released here.
#
#   npm run release:demo                       # release origin/main's tip
#   npm run release:demo -- <sha>              # release an earlier commit of main
#   npm run release:demo -- --yes              # no confirmation prompt
#   npm run release:demo -- --rollback <sha>   # move demo BACK to an earlier commit of main
#
# Refuses a commit that is not on origin/main (demo never carries commits main lacks), a release
# that is not a fast-forward of demo (unless --rollback), and a dirty working tree.
set -euo pipefail

cd "$(dirname "$0")/.."

YES=0
ROLLBACK=0
TARGET=""
while (($#)); do
  case "$1" in
    --yes) YES=1 ;;
    --rollback) ROLLBACK=1 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) [[ -z "$TARGET" ]] || { echo "Only one commit may be given." >&2; exit 2; }; TARGET="$1" ;;
  esac
  shift
done
if ((ROLLBACK)) && [[ -z "$TARGET" ]]; then
  echo "--rollback needs the commit to move demo back to." >&2
  exit 2
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "The working tree has uncommitted changes to tracked files; commit or stash them first." >&2
  exit 1
fi

git fetch --quiet origin main demo
sha="$(git rev-parse --verify "${TARGET:-origin/main}^{commit}")"
demo="$(git rev-parse --verify origin/demo^{commit})"
short="$(git rev-parse --short=8 "$sha")"

if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "$short is not on origin/main; push it to main first." >&2
  exit 1
fi
if [[ "$sha" == "$demo" ]]; then
  echo "demo is already at $short; nothing to release."
  exit 0
fi

if ((ROLLBACK)); then
  if ! git merge-base --is-ancestor "$sha" "$demo"; then
    echo "--rollback moves demo back; $short is not behind demo ($(git rev-parse --short=8 "$demo"))." >&2
    exit 1
  fi
  echo "Rolling demo back from $(git rev-parse --short=8 "$demo") to $short, dropping:"
  git log --oneline "$sha..$demo"
else
  if ! git merge-base --is-ancestor "$demo" "$sha"; then
    echo "$short is not a fast-forward of demo ($(git rev-parse --short=8 "$demo")); use --rollback to move it back." >&2
    exit 1
  fi
  echo "Releasing to the demo ($(git rev-parse --short=8 "$demo") → $short):"
  git log --oneline "$demo..$sha"
fi

# The link-preview image (client/public/og-image.png) is a screenshot of the dashboard. Say so when
# the client changed after it was last rendered; never block the release over it.
if ((!ROLLBACK)); then
  og=client/public/og-image.png
  og_sha="$(git log -1 --format=%H "$sha" -- "$og" || true)"
  if [[ -z "$og_sha" ]]; then
    echo
    echo "Note: $og is not in $short; render it with:"
    echo "  node scripts/render-og-image.mjs --url=https://nw-tracker-demo.onrender.com"
  else
    ui_changes="$(git rev-list --count "$og_sha..$sha" -- client/src client/index.html ':!client/src/**/*.test.ts' ':!client/src/**/*.test.tsx')"
    if ((ui_changes > 0)); then
      echo
      echo "Note: $og was rendered at $(git rev-parse --short=8 "$og_sha") ($(git log -1 --format=%cs "$og_sha")); $ui_changes client commit(s) since."
      echo "Once this release is live, re-render it against the demo and commit it to main:"
      echo "  node scripts/render-og-image.mjs --url=https://nw-tracker-demo.onrender.com"
    fi
  fi
fi

if ((!YES)); then
  read -r -p "Push to demo? [y/N] " answer
  [[ "$answer" == [yY] ]] || { echo "Not released."; exit 1; }
fi

if ((ROLLBACK)); then
  git push --force-with-lease="demo:$demo" origin "$sha:refs/heads/demo"
else
  git push origin "$sha:refs/heads/demo"
fi
echo "demo is at $short; Render deploys it. Check https://nw-tracker-demo.onrender.com/api/health once the build is done."
