#!/bin/sh
set -eu
case "${VOLUME_TEST_FAILURE:-}:$*" in
  copy:*"cp -a /from/"*) echo "Injected copy failure" >&2; exit 19 ;;
  shutdown:"stop "*) echo "Injected shutdown failure" >&2; exit 20 ;;
  backup:*"tar -cz -C /from"*) echo "Injected backup failure" >&2; exit 21 ;;
esac
exec /usr/local/bin/docker "$@"
