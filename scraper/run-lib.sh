# Shared helpers for the pipeline runner scripts (`daily-run.sh`, `email-run.sh`).
# Sourced, not executed: `step` mutates the caller's `failed` / `steps_json` globals, which
# every runner must initialise (`failed=0`, `steps_json="[]"`) before its first step.

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Append one step result. Built with python3 so a label with quotes cannot break the JSON.
add_step() {
  steps_json="$(STEPS="$steps_json" LABEL="$1" OK="$2" SECONDS_TAKEN="$3" python3 -c '
import json, os
steps = json.loads(os.environ["STEPS"])
steps.append({
    "label": os.environ["LABEL"],
    "ok": os.environ["OK"] == "1",
    "seconds": float(os.environ["SECONDS_TAKEN"]),
})
print(json.dumps(steps))
')"
}

step() {
  local label="$1"; shift
  local started ended
  started=$(date +%s)
  log "=== $label"
  if "$@"; then
    ended=$(date +%s)
    log "--- ok: $label"
    add_step "$label" 1 "$((ended - started))"
  else
    local code=$?
    ended=$(date +%s)
    log "*** FAILED ($code): $label"
    failed=$((failed + 1))
    add_step "$label" 0 "$((ended - started))"
  fi
}
