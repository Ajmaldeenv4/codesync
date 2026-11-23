#!/bin/sh
# Runs a private Docker daemon next to the runner inside one VM (a Fly Machine).
#
# Sandboxes have no network, so the daemon needs no bridge and no iptables/nftables rules. It
# listens on a Unix socket only, never TCP. The runner itself refuses to run code until it has
# verified, from inside a container, that this host enforces the sandbox limits.
set -eu

DATA_ROOT="${DOCKER_DATA_ROOT:-/data/docker}"
mkdir -p "$DATA_ROOT"
rm -f /var/run/docker.pid

# Some VMs boot without cgroup v2 mounted; without it no resource limit can be enforced.
if [ ! -e /sys/fs/cgroup/cgroup.controllers ]; then
  mount -t cgroup2 none /sys/fs/cgroup || echo "warning: could not mount cgroup2" >&2
fi

# `dind` (from the docker image) enables the cgroup controllers for nested containers.
dind dockerd \
  --host=unix:///var/run/docker.sock \
  --data-root="$DATA_ROOT" \
  --bridge=none --iptables=false --ip6tables=false \
  --log-level=warn &
DOCKERD=$!

node --import tsx src/index.ts &
RUNNER=$!

stop() {
  kill -TERM "$RUNNER" 2>/dev/null || true
  wait "$RUNNER" 2>/dev/null || true
  kill -TERM "$DOCKERD" 2>/dev/null || true
  wait "$DOCKERD" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT

# If either process dies the VM is useless: exit so the platform restarts it.
while kill -0 "$DOCKERD" 2>/dev/null && kill -0 "$RUNNER" 2>/dev/null; do
  sleep 1 &
  wait $! || true
done
echo "dockerd or the runner exited; stopping" >&2
stop
exit 1
