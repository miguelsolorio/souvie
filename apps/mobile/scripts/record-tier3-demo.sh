#!/usr/bin/env bash
# Records the Tier 3 browser host demo (WS08 demo round) on the iPhone 17 Pro Simulator.
#
#   pnpm --filter @mp/mobile tier3:demo /path/to/demo.mp4
#
# Writes demo.mp4 and, beside it, demo.png: the final frame, two seconds after the Done caption.
# The recording starts on the demo screen (souvie://snapshot?demo=1) and ends two seconds after
# "Done in N s". Launch, bundling and the page's first load happen before it starts.
#
# What it does, in order:
#   1. boots the Simulator if it is not booted
#   2. generates the native project if ios/ is missing (expo prebuild, then pod install) and builds
#      the Debug app with xcodebuild. `expo run:ios` is not used: on a Mac with no signing identity
#      it takes the physical-device path and fails with "No code signing certificates"
#   3. starts the test page server (tier3:test-page, port 8790) and Metro, with placeholder
#      Supabase values. No account or hosted data is touched (see the note on .env.local below)
#   4. warms the bundle, so no bundling shows in the recording
#   5. points the app at Metro (the RCT_jsLocation default), opens the demo screen with
#      `simctl openurl` on a cold start (no Safari, no "Open in" prompt), and waits for the app to
#      print "[tier3-demo] ready", which it does once the screen is up and the page has loaded
#   6. records until the app prints "[tier3-demo] done", plus two seconds
#   7. puts everything back: package.json, the bundler setting, the app, the servers, the logs
#
# About .env.local: this script never opens it. Metro's own config (metro.config.js) does. On
# `expo start` it reads the repo-root .env.local and copies each EXPO_PUBLIC_* value whose name is
# not already set in the environment. Before starting Metro, this script sets every EXPO_PUBLIC_*
# name that .env.example lists to empty (and the two Supabase values to placeholders), so Metro
# finds each of those names already set and discards the file's values. That is why none of them
# reaches the demo build. A name in .env.local that .env.example does not list would still be
# copied; every name the app reads is listed there.
#
# Environment (all optional):
#   SIM_NAME      Simulator name, default "iPhone 17 Pro"
#   SIM_UDID      use this device instead of looking SIM_NAME up
#   METRO_PORT    first port to try for Metro, default 8083 (8081 is where most people run theirs)
#   SKIP_BUILD=1  reuse the app already built under ios/build
#   REUSE_SERVER=1  record whatever already serves the test page port, instead of refusing
#   TAIL_SECONDS  how long to keep recording after the Done caption, default 2
#   KEEP_LOGS=1   keep the log directory (it is removed on exit; a failure prints the log's tail)
#   PNPM          the pnpm command, default "corepack pnpm" (no global pnpm on this Mac)
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: record-tier3-demo.sh <output.mp4>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# A relative output path is relative to where the person ran the command, not to apps/mobile.
case "$1" in
  /*) OUT="$1" ;;
  *) OUT="${INIT_CWD:-$PWD}/$1" ;;
esac
case "$OUT" in
  *.mp4) PNG="${OUT%.mp4}.png" ;;
  *) PNG="$OUT.png" ;;
esac
mkdir -p "$(dirname "$OUT")"

PNPM="${PNPM:-corepack pnpm}"
SIM_NAME="${SIM_NAME:-iPhone 17 Pro}"
SIM_UDID="${SIM_UDID:-}"
BUNDLE_ID="com.miguelsolorio.souvie"
DEMO_URL="souvie://snapshot?demo=1"
TEST_PAGE_PORT="${TIER3_TEST_PAGE_PORT:-8790}"
TEST_PAGE_URL="http://localhost:${TEST_PAGE_PORT}/"
APP="$MOBILE_DIR/ios/build/Build/Products/Debug-iphonesimulator/Souvie.app"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tier3-demo.XXXXXX")"

# CocoaPods stops with an encoding error unless the locale is UTF-8.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# --- cleanup, whatever happens -------------------------------------------------------------------
# Everything this script changes is undone here: package.json (prebuild rewrites it), the
# Simulator's bundler setting, the app, the recorder, the servers and the log directory. The traps
# are set before anything is changed, and each change sets its flag before it is made.
PIDS=()
REC_PID=""
PACKAGE_JSON_BACKUP=""
BUNDLER_SETTING_CHANGED=0
PREVIOUS_JS_LOCATION=""

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# stop_recorder: ask the recorder to close the file (INT), give it ten seconds, then kill it.
# Returns 1 when it had to be killed, because the video is then not finished.
stop_recorder() {
  local pid="$REC_PID" ticks=0 result=0
  [ -n "$pid" ] || return 0
  REC_PID=""
  kill -INT "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null; do
    ticks=$((ticks + 1))
    if [ "$ticks" -ge 50 ]; then
      kill -KILL "$pid" 2>/dev/null
      result=1
      break
    fi
    sleep 0.2
  done
  wait "$pid" 2>/dev/null
  return "$result"
}

# restore_package_json: put package.json back as it was before expo prebuild rewrote it.
restore_package_json() {
  if [ -n "$PACKAGE_JSON_BACKUP" ] && [ -f "$PACKAGE_JSON_BACKUP" ]; then
    cp "$PACKAGE_JSON_BACKUP" "$MOBILE_DIR/package.json"
  fi
  PACKAGE_JSON_BACKUP=""
}

cleanup() {
  local status=$?
  set +e
  stop_recorder
  restore_package_json
  if [ -n "$SIM_UDID" ]; then
    xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1
    if [ "$BUNDLER_SETTING_CHANGED" = 1 ]; then
      if [ -n "$PREVIOUS_JS_LOCATION" ]; then
        xcrun simctl spawn "$SIM_UDID" defaults write "$BUNDLE_ID" RCT_jsLocation "$PREVIOUS_JS_LOCATION"
      else
        xcrun simctl spawn "$SIM_UDID" defaults delete "$BUNDLE_ID" RCT_jsLocation >/dev/null 2>&1
      fi
      log "bundler setting restored"
    fi
  fi
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill_tree "$pid"
  done
  if [ "${KEEP_LOGS:-0}" = 1 ]; then
    log "logs kept in $WORK"
  else
    # Only ever a directory this script made with mktemp.
    case "$WORK" in
      */tier3-demo.*) rm -rf "$WORK" ;;
    esac
  fi
  exit "$status"
}

log() { printf '[record-tier3-demo] %s\n' "$*"; }

# fail <message> [log file]: say what went wrong, with the end of the log that explains it.
fail() {
  printf '[record-tier3-demo] FAILED: %s\n' "$1" >&2
  if [ -n "${2:-}" ] && [ -s "$2" ]; then
    printf '[record-tier3-demo] last lines of %s:\n' "$(basename "$2")" >&2
    tail -n 30 "$2" >&2
  fi
  exit 1
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v xcrun >/dev/null || fail "xcrun not found. This needs Xcode on a Mac."

# --- the Simulator -------------------------------------------------------------------------------
if [ -z "$SIM_UDID" ]; then
  SIM_UDID="$(xcrun simctl list devices available | sed -nE "s/^ *${SIM_NAME} \(([0-9A-F-]{36})\).*/\1/p" | head -n 1)"
fi
[ -n "$SIM_UDID" ] || fail "no available Simulator named \"$SIM_NAME\""
log "Simulator: $SIM_NAME ($SIM_UDID)"
xcrun simctl bootstatus "$SIM_UDID" -b >/dev/null 2>&1 || fail "could not boot the Simulator"

# wait_for_log <file> <fixed text> <seconds>
wait_for_log() {
  local file="$1" text="$2" limit="$3" ticks=0
  until grep -qF -- "$text" "$file" 2>/dev/null; do
    sleep 0.25
    ticks=$((ticks + 1))
    [ "$ticks" -lt $((limit * 4)) ] || return 1
  done
}

# seen_since <file> <lines to skip> <fixed text>: the text appears after that many lines.
# (awk, not tail | grep -q: under pipefail, grep quitting early makes the pipe look failed.)
seen_since() {
  awk -v skip="$2" -v text="$3" 'NR > skip && index($0, text) > 0 { found = 1 } END { exit found ? 0 : 1 }' "$1"
}

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# A test page server that is already up may serve another checkout's page. Refuse it now, before the
# build, unless the person says to record it anyway.
START_TEST_PAGE_SERVER=1
if port_in_use "$TEST_PAGE_PORT"; then
  [ "${REUSE_SERVER:-0}" = 1 ] ||
    fail "port $TEST_PAGE_PORT is already in use. If that is a test page server from another checkout, its page, not this one, would be in the recording. Stop it, or set REUSE_SERVER=1 to record what it serves."
  START_TEST_PAGE_SERVER=0
fi

# --- the native app ------------------------------------------------------------------------------
cd "$MOBILE_DIR"
if [ ! -d ios/Souvie.xcworkspace ]; then
  log "generating the native project (expo prebuild, then pod install)"
  # prebuild rewrites the ios and android scripts in package.json. The backup is registered before
  # prebuild starts, so cleanup restores the file on any exit, an interrupt included.
  PACKAGE_JSON_BACKUP="$WORK/package.json.bak"
  cp package.json "$PACKAGE_JSON_BACKUP"
  prebuild_status=0
  CI=1 $PNPM exec expo prebuild --platform ios --no-install >"$WORK/prebuild.log" 2>&1 || prebuild_status=$?
  restore_package_json
  [ "$prebuild_status" -eq 0 ] || fail "expo prebuild failed" "$WORK/prebuild.log"
  (cd ios && pod install >"$WORK/pod-install.log" 2>&1) || fail "pod install failed" "$WORK/pod-install.log"
fi

if [ "${SKIP_BUILD:-0}" = 1 ] && [ -d "$APP" ]; then
  log "reusing the built app (SKIP_BUILD=1)"
else
  log "building the Debug app with xcodebuild (about three minutes the first time)"
  xcodebuild \
    -workspace ios/Souvie.xcworkspace \
    -scheme Souvie \
    -configuration Debug \
    -sdk iphonesimulator \
    -destination "id=$SIM_UDID" \
    -derivedDataPath ios/build \
    build >"$WORK/xcodebuild.log" 2>&1 || fail "xcodebuild failed" "$WORK/xcodebuild.log"
fi
[ -d "$APP" ] || fail "no app at $APP"
xcrun simctl install "$SIM_UDID" "$APP"

# --- the test page and Metro ---------------------------------------------------------------------
if [ "$START_TEST_PAGE_SERVER" = 1 ]; then
  $PNPM run tier3:test-page >"$WORK/test-page.log" 2>&1 &
  PIDS+=("$!")
  wait_for_log "$WORK/test-page.log" "Tier 3 test page at" 30 || fail "the test page server did not start" "$WORK/test-page.log"
  log "test page at $TEST_PAGE_URL"
else
  log "reusing the server on port $TEST_PAGE_PORT (REUSE_SERVER=1)"
fi

METRO_PORT="${METRO_PORT:-8083}"
while port_in_use "$METRO_PORT"; do
  METRO_PORT=$((METRO_PORT + 1))
done

# The environment for Metro: every EXPO_PUBLIC_* name .env.example lists is set, empty, so Metro's
# own .env.local reading (see the note at the top) finds nothing left to copy. The two Supabase
# values are placeholders: the app only needs them to render, and 127.0.0.1:54321 is this Mac.
while IFS= read -r name; do
  export "$name="
done < <(grep -oE '^EXPO_PUBLIC_[A-Z0-9_]+' "$MOBILE_DIR/../../.env.example" 2>/dev/null || true)
export EXPO_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
export EXPO_PUBLIC_SUPABASE_ANON_KEY="placeholder-anon-key"
export EXPO_PUBLIC_TIER3_TEST_PAGE_URL="$TEST_PAGE_URL"
export EXPO_NO_TELEMETRY=1

CI=1 $PNPM exec expo start --port "$METRO_PORT" >"$WORK/metro.log" 2>&1 &
PIDS+=("$!")
ticks=0
until [ "$(curl -fs "http://localhost:$METRO_PORT/status" 2>/dev/null || true)" = "packager-status:running" ]; do
  sleep 0.5
  ticks=$((ticks + 1))
  [ "$ticks" -lt 120 ] || fail "Metro did not start" "$WORK/metro.log"
done
log "Metro on port $METRO_PORT"

# --- point the app at Metro ----------------------------------------------------------------------
PREVIOUS_JS_LOCATION="$(xcrun simctl spawn "$SIM_UDID" defaults read "$BUNDLE_ID" RCT_jsLocation 2>/dev/null || true)"
BUNDLER_SETTING_CHANGED=1
xcrun simctl spawn "$SIM_UDID" defaults write "$BUNDLE_ID" RCT_jsLocation "localhost:$METRO_PORT"

# Warm the bundle: the first launch makes Metro build it, which takes a while. Do that unrecorded.
xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID" >/dev/null
log "bundling (first launch)"
wait_for_log "$WORK/metro.log" "Bundled" 240 || fail "Metro did not bundle the app" "$WORK/metro.log"
sleep 6
xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
sleep 1

# --- open the demo screen, then record -----------------------------------------------------------
# Opening the URL with the app closed starts it on that route, so there is no race with the app's
# own startup. The recording is not running yet.
READY_FROM="$(wc -l <"$WORK/metro.log" | tr -d ' ')"
xcrun simctl openurl "$SIM_UDID" "$DEMO_URL"
log "opened $DEMO_URL, waiting for the demo screen"

ticks=0
until seen_since "$WORK/metro.log" "$READY_FROM" "[tier3-demo] ready"; do
  sleep 0.1
  ticks=$((ticks + 1))
  [ "$ticks" -lt 600 ] || fail "the demo screen did not come up" "$WORK/metro.log"
done

rm -f "$OUT"
xcrun simctl io "$SIM_UDID" recordVideo --codec=h264 --force "$OUT" >"$WORK/record.log" 2>&1 &
REC_PID=$!
log "recording to $OUT"

ticks=0
until seen_since "$WORK/metro.log" "$READY_FROM" "[tier3-demo] done" ||
  seen_since "$WORK/metro.log" "$READY_FROM" "[tier3-demo] failed"; do
  sleep 0.1
  ticks=$((ticks + 1))
  [ "$ticks" -lt 450 ] || fail "the demo did not finish within 45 s" "$WORK/metro.log"
done
if seen_since "$WORK/metro.log" "$READY_FROM" "[tier3-demo] failed"; then
  fail "the demo stopped with an error" "$WORK/metro.log"
fi

# Two seconds on the Done caption. The log line reaches Metro about as late as the recorder takes to
# close, so a plain two seconds gives a tail of two (measured: 1.8 from a wait of 1.8). The PNG is
# taken after the recorder stops, so taking it does not stretch the tail.
sleep "${TAIL_SECONDS:-2}"
stop_recorder || fail "the recorder did not stop when asked, so the video may be cut off" "$WORK/record.log"
# The screen still shows the Done caption: nothing moves after it.
xcrun simctl io "$SIM_UDID" screenshot --type=png "$PNG" >"$WORK/screenshot.log" 2>&1 ||
  fail "could not take the final screenshot" "$WORK/screenshot.log"

[ -s "$OUT" ] || fail "no video was written" "$WORK/record.log"
[ -s "$PNG" ] || fail "no final screenshot was written" "$WORK/screenshot.log"
log "video: $OUT"
log "final frame: $PNG"
if command -v ffprobe >/dev/null; then
  log "duration: $(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT") s"
fi
awk -v skip="$READY_FROM" 'NR > skip && index($0, "[tier3-demo]") > 0 { print "[app] " $0 }' "$WORK/metro.log"
