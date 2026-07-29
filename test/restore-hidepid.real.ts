import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESTORE_SH = process.env.RESTORE_HIDEPID_SCRIPT ?? path.join(REPO, 'scripts', 'restore.sh')
const IMAGE = 'node:26-bookworm'
const CONTAINER_ID = 'a'.repeat(64)
const NETWORK_ID = 'b'.repeat(64)

function commandOutput(result: ReturnType<typeof spawnSync>): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

test('real Linux hidepid keeps a live cross-UID restore owner unknown without containment', { timeout: 60_000 }, () => {
  const fixtureRoot = mkdtempSync(path.join(os.homedir(), '.xjm-restore-hidepid-'))
  const containerName = `xjm-restore-hidepid-${process.pid}-${Date.now()}`

  try {
    const dockerInfo = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(dockerInfo.status, 0, `Docker daemon is required:\n${commandOutput(dockerInfo)}`)
    assert.equal(dockerInfo.stdout.trim(), 'linux', 'Docker daemon must provide Linux containers')

    const restoreCopy = path.join(fixtureRoot, 'restore.sh')
    copyFileSync(RESTORE_SH, restoreCopy)
    chmodSync(restoreCopy, 0o755)

    writeFileSync(
      path.join(fixtureRoot, 'docker-stub.sh'),
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$DOCKER_LOG"

if [ "$1" = "compose" ]; then
  case "$2" in
    config)
      exit 0
      ;;
    ps)
      printf '%s\n' '${CONTAINER_ID}'
      exit 0
      ;;
  esac
fi

case "$1" in
  inspect)
    if [ "$2" = "--format" ]; then
      case "$3" in
        *State.Running*)
          if [ -f "$DOCKER_STATE/stopped" ]; then printf '%s\n' false; else printf '%s\n' true; fi
          ;;
        *NetworkSettings.Networks*)
          if [ ! -f "$DOCKER_STATE/disconnected" ]; then printf '%s\n' '${NETWORK_ID}'; fi
          ;;
      esac
    fi
    exit 0
    ;;
  stop)
    : > "$DOCKER_STATE/stopped"
    exit 0
    ;;
  network)
    if [ "$2" = "disconnect" ]; then : > "$DOCKER_STATE/disconnected"; fi
    exit 0
    ;;
  ps)
    printf '%s\n' '${CONTAINER_ID}'
    exit 0
    ;;
esac

exit 1
`,
      { mode: 0o755 },
    )

    writeFileSync(
      path.join(fixtureRoot, 'run-retry.sh'),
      `#!/bin/sh
set -eu

hidepid_options=$(awk '$2 == "/proc" && $4 ~ /hidepid=(2|invisible)/ { print $4; found = 1 } END { if (!found) exit 1 }' /proc/mounts)
printf 'HIDEPID_OPTIONS=%s\n' "$hidepid_options"

[ "$(id -u)" = "2001" ] || { echo 'retry did not run as uid 2001' >&2; exit 70; }
[ "$$" = "1" ] || { echo 'retry did not retain PID 1' >&2; exit 71; }
[ -d /proc/1 ] || { echo '/proc/1 must remain visible to the retry owner' >&2; exit 72; }

if cat "/proc/$OWNER_PID/stat" >/dev/null 2>&1; then
  echo 'cross-UID owner stat unexpectedly remained readable' >&2
  exit 73
fi
if find /proc -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -print 2>/dev/null \
  | grep -Fx "/proc/$OWNER_PID" >/dev/null; then
  echo 'cross-UID owner PID unexpectedly remained enumerable' >&2
  exit 74
fi

heartbeat_before=$(cat /work/owner-heartbeat)
sleep 1
heartbeat_after=$(cat /work/owner-heartbeat)
[ "$heartbeat_before" != "$heartbeat_after" ] || { echo 'cross-UID owner heartbeat stopped' >&2; exit 75; }
printf 'OWNER_PROBE=live-stat-denied-directory-hidden\n'

set +e
PATH="/work/bin:$PATH" \
SUDO= \
DATA_DIR=/work/data \
BACKUP_DIR=/work/data/backups \
DOCKER_LOG=/work/docker.log \
DOCKER_STATE=/work/docker-state \
sh /work/restore.sh /work/data/backups/snapshot.db \
  >/work/restore.stdout 2>/work/restore.stderr
restore_rc=$?
set -e

stop_count=$(awk '$1 == "stop" { count++ } END { print count + 0 }' /work/docker.log)
disconnect_count=$(awk '$1 == "network" && $2 == "disconnect" { count++ } END { print count + 0 }' /work/docker.log)

printf 'RESTORE_RC=%s\n' "$restore_rc"
printf 'STOP_COUNT=%s\n' "$stop_count"
printf 'DISCONNECT_COUNT=%s\n' "$disconnect_count"
cat /work/restore.stderr

[ "$restore_rc" = "4" ] || exit 76
[ "$stop_count" = "0" ] || exit 77
[ "$disconnect_count" = "0" ] || exit 78
`,
      { mode: 0o755 },
    )

    writeFileSync(
      path.join(fixtureRoot, 'entrypoint.sh'),
      `#!/bin/sh
set -eu

[ "$$" = "1" ] || { echo 'container entrypoint must be PID 1' >&2; exit 60; }
mount -t proc proc /proc -o hidepid=2

mkdir -p /work/bin /work/data/backups /work/data.restore-control /work/docker-state
cp /fixture/restore.sh /work/restore.sh
cp /fixture/docker-stub.sh /work/bin/docker
cp /fixture/run-retry.sh /work/run-retry.sh
chmod 755 /work/restore.sh /work/bin/docker /work/run-retry.sh
: > /work/docker.log
: > /work/data/backups/snapshot.db
: > /work/data.restore-control/app-started
printf '%s\n' '${CONTAINER_ID}' > /work/data.restore-control/container-id
printf '%s\n' xiaojimao-hub > /work/data.restore-control/compose-project
printf '%s\n' app > /work/data.restore-control/compose-service

sh -c 'while :; do date +%s%N > /work/owner-heartbeat; sleep 0.2; done' &
owner_pid=$!
tries=0
while [ ! -s /work/owner-heartbeat ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || { echo 'owner heartbeat did not start' >&2; exit 61; }
  sleep 0.1
done

boot_id=$(cat /proc/sys/kernel/random/boot_id)
owner_ticks=$(awk '{ print $22 }' "/proc/$owner_pid/stat")
case "$owner_ticks" in ''|*[!0-9]*) echo 'invalid owner start ticks' >&2; exit 62 ;; esac
printf '%s\n' "$owner_pid" > /work/data.restore-control/owner-pid
printf 'v2 linux-proc %s %s\n' "$boot_id" "$owner_ticks" > /work/data.restore-control/owner-start-fingerprint

chown -R 2001:2001 /work
exec setpriv --reuid=2001 --regid=2001 --clear-groups \
  env OWNER_PID="$owner_pid" /work/run-retry.sh
`,
      { mode: 0o755 },
    )

    const result = spawnSync(
      'docker',
      [
        'run', '--rm', '--privileged', '--network', 'none', '--read-only',
        '--pull', 'never', '--name', containerName,
        '--tmpfs', '/work:rw,exec,nosuid,nodev,mode=1777',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777',
        '-v', `${fixtureRoot}:/fixture:ro`,
        IMAGE, 'sh', '/fixture/entrypoint.sh',
      ],
      { encoding: 'utf8', timeout: 45_000 },
    )

    assert.equal(result.error, undefined, `real Linux hidepid test failed to execute:\n${commandOutput(result)}`)
    assert.equal(result.status, 0, `real Linux hidepid regression failed:\n${commandOutput(result)}`)
    assert.match(result.stdout, /^HIDEPID_OPTIONS=.*hidepid=(?:2|invisible)/m)
    assert.match(result.stdout, /^OWNER_PROBE=live-stat-denied-directory-hidden$/m)
    assert.match(result.stdout, /^RESTORE_RC=4$/m)
    assert.match(result.stdout, /^STOP_COUNT=0$/m)
    assert.match(result.stdout, /^DISCONNECT_COUNT=0$/m)
  } finally {
    spawnSync('docker', ['rm', '-f', containerName], {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 10_000,
    })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
