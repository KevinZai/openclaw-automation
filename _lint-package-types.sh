#!/usr/bin/env bash
# _lint-package-types.sh — detect ESM/CJS package.json mismatches.
#
# For every .js file under the configured roots, walk up the directory tree
# to the nearest package.json. If that package.json has "type": "module",
# the .js file MUST use ESM `import` (not CommonJS `require()`).
#
# Files that violate this would crash at runtime with:
#   ReferenceError: require is not defined in ES module scope
#
# Usage:
#   bash scripts/_lint-package-types.sh                # default roots
#   bash scripts/_lint-package-types.sh path1 path2    # custom roots
#
# Exit codes:
#   0 = clean
#   1 = one or more violations
#   2 = invocation/internal error

set -uo pipefail

# Default roots (relative to repo root). Add more as the repo grows.
DEFAULT_ROOTS=(
  "scripts"
  "tools"
)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to $REPO_ROOT" >&2; exit 2; }

if [ "$#" -gt 0 ]; then
  ROOTS=("$@")
else
  ROOTS=("${DEFAULT_ROOTS[@]}")
fi

# Walk up from a file's directory looking for package.json. Echoes path or empty.
find_pkg_json() {
  local dir="$1"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -f "$dir/package.json" ]; then
      echo "$dir/package.json"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Returns 0 if package.json declares "type": "module".
is_module_pkg() {
  local pkg="$1"
  # Tolerate whitespace and trailing comma. node -p is the safe parser.
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(j.type === "module" ? 0 : 1);
    } catch (e) { process.exit(2); }
  ' "$pkg"
}

# Returns 0 if file uses CommonJS require() at top level (heuristic: literal "require(").
uses_require() {
  local file="$1"
  # Simple grep — strip line comments first, then test for require(.
  grep -vE '^\s*//' "$file" | grep -qE '\brequire\s*\('
}

violations=()
checked=0

for root in "${ROOTS[@]}"; do
  if [ ! -d "$root" ]; then
    continue
  fi
  # -print0 to tolerate spaces; skip node_modules and dot-dirs.
  while IFS= read -r -d '' jsfile; do
    checked=$((checked + 1))
    pkg="$(find_pkg_json "$(dirname "$jsfile")")" || continue
    if is_module_pkg "$pkg"; then
      if uses_require "$jsfile"; then
        violations+=("$jsfile  (pkg: $pkg)")
      fi
    fi
  done < <(find "$root" -type f -name '*.js' \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -print0)
done

echo "[lint-package-types] checked $checked .js files under: ${ROOTS[*]}"

if [ "${#violations[@]}" -eq 0 ]; then
  echo "[lint-package-types] PASS — no ESM/CJS mismatches found."
  exit 0
fi

echo "[lint-package-types] FAIL — ${#violations[@]} violation(s):"
printf '  - %s\n' "${violations[@]}"
echo ""
echo "Fix: rename each file from .js to .cjs (and update any references — e.g. PM2 ecosystem)."
exit 1
