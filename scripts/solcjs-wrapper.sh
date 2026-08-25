#!/bin/bash
# solcjs (the npm-installed WASM build of solc) doesn't understand a few
# flags that Slither/crytic-compile always pass when invoking an external
# "solc" binary (e.g. --allow-paths, which is only meaningful for a native
# binary reading files off disk — our standard-json input already has every
# source inlined, so there's nothing for it to resolve). This wrapper drops
# those flags and forwards everything else to the real solcjs binary.
args=()
skip_next=false
for arg in "$@"; do
  if [ "$skip_next" = true ]; then
    skip_next=false
    continue
  fi
  case "$arg" in
    --allow-paths)
      skip_next=true
      ;;
    --allow-paths=*)
      ;;
    *)
      args+=("$arg")
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLCJS="$SCRIPT_DIR/../node_modules/.bin/solcjs"

exec "$SOLCJS" "${args[@]}" | sed -n '/^{/,$p'
