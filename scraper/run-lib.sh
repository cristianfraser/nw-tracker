# Shared helpers for the pipeline runner scripts (`daily-run.sh`, `email-run.sh`).
# Sourced, not executed: `step` mutates the caller's `failed` / `steps_json` / `current_step`
# globals, which every runner must initialise (`failed=0`, `steps_json="[]"`, `current_step=""`)
# before its first step.

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
  current_step="$label"
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
  current_step=""
}

# A runner killed while a step runs never reaches that step's add_step: bash delivers the signal
# once the foreground child exits and goes straight to the EXIT trap, which then records only the
# steps completed BEFORE it — an empty list when the first step was the one killed. That is how a
# run whose Chrome window was closed by hand mid-fetch went down as «0 step(s), all ok»
# (2026-09-08). The runners' `finish` traps call this first, so the step in flight is recorded
# as a failure and the run is badged like any other.
record_interrupted_step() {
  if [[ -n "${current_step:-}" ]]; then
    log "*** INTERRUPTED: $current_step"
    failed=$((failed + 1))
    add_step "$current_step (interrupted)" 0 0
    current_step=""
  fi
}
