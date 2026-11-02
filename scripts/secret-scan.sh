#!/usr/bin/env bash
#
# secret-scan.sh — SE-01 repository secret audit.
#
# Scans (a) the current tracked tree and (b) the full git history of the
# Connector Foundry subtree for known secret shapes, and fails loudly on
# anything that is not on the documented allowlist.
#
# The script NEVER prints matched values — findings are file:line (+commit for
# history) and pattern name only, so a leaked secret can't spread through CI
# logs or chat reports.
#
# Usage:
#   ./scripts/secret-scan.sh [REPO_DIR]
#
# Env:
#   CF_SCAN_SCOPE        path within the repo to scan (default:
#                        projects/connector-foundry; use "." for a fixture repo)
#   CF_SCAN_HISTORY=0    skip the history scan (tracked tree only)
#   SECRET_SCAN_ALLOWLIST  path to the allowlist file (default: the one next
#                        to this script)
#
# Exit 0: no unallowlisted findings. Exit 1: unallowlisted findings exist.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "${REPO}" ]]; then
  echo "secret-scan: cannot determine repo root (not in a git checkout?)" >&2
  exit 2
fi
SCOPE="${CF_SCAN_SCOPE:-projects/connector-foundry}"
SCAN_HISTORY="${CF_SCAN_HISTORY:-1}"
ALLOWLIST="${SECRET_SCAN_ALLOWLIST:-$SCRIPT_DIR/secret-scan.allowlist}"

# name -> extended regex. Keep these literal where possible; the scanner
# itself is allowlisted for the patterns it must contain verbatim.
declare -A PATTERNS=(
  [aws_access_key_id]='AKIA[0-9A-Z]{16}'
  [aws_secret_key]='aws_secret_access_key["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+=]{40}'
  [stripe_live_key]='sk_live_[0-9A-Za-z]{10,}'
  [stripe_test_key]='sk_test_[0-9A-Za-z]{10,}'
  [stripe_webhook]='whsec_[0-9A-Za-z]{10,}'
  [github_token]='(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}'
  [github_pat]='github_pat_[0-9A-Za-z_]{22,}'
  [slack_token]='xox[baprs]-[0-9A-Za-z-]{8,}'
  [private_key]='-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
  [openai_key]='sk-[0-9A-Za-z]{32,}'
  [gateway_key]='cf_live_[0-9A-Za-z]{20,}'
  [generic_assignment]='(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[^"'"'"'[:space:]<>]{8,}'
)

# Values that are documentation placeholders, never credentials.
PLACEHOLDER='(<redacted>|\{[^}]*\}|changeme|example|your[-_].*|xxx+|todo)'

# --- allowlist ---------------------------------------------------------------
# Lines: <path-glob><TAB><pattern-name|*><TAB><reason>. Blank lines and lines
# starting with # are ignored. Globs are relative to the scope root and are
# matched with bash's [[ == ]] against the finding's path (path@commit for
# history hits).
allowlisted() {
  local path="$1" name="$2"
  [[ -f "$ALLOWLIST" ]] || return 1
  local glob pat
  while IFS=$'\t' read -r glob pat _reason; do
    [[ -z "$glob" || "$glob" == \#* ]] && continue
    [[ "$pat" != "$name" && "$pat" != "*" ]] && continue
    local rel="${path#${SCOPE}/}"
    [[ "$rel" == "$path" ]] && rel="$path"  # scope already "."
    # shellcheck disable=SC2053
    if [[ "$rel" == $glob ]]; then
      return 0
    fi
  done < "$ALLOWLIST"
  return 1
}

# --- scan one stream ---------------------------------------------------------
# Input lines are path|line|where|text  (\034-separated). "where" is "tree"
# or "commit <sha>" for history hits.
FINDINGS=0
check_stream() {
  local stream_label="$1" path lineno where text name
  while IFS=$'\034' read -r path lineno where text; do
    for name in "${!PATTERNS[@]}"; do
      # Extract the matched value; placeholder screening applies to the VALUE
      # only — never the whole line (a real secret can share a line with an
      # "example.com" email, and must still be reported).
      match="$(grep -oE -e "${PATTERNS[$name]}" <<<"$text" | head -n 1 || true)"
      if [[ -n "$match" ]]; then
        if grep -qiE -e "$PLACEHOLDER" <<<"$match"; then
          continue  # documentation placeholder, not a credential
        fi
        local id="$path"
        if allowlisted "$path" "$name"; then
          continue
        fi
        [[ "$where" == commit* ]] && id="$path ($where)"
        echo "FINDING [$stream_label] $id:$lineno pattern=$name"
        FINDINGS=$((FINDINGS + 1))
        break
      fi
    done
  done
  return 0  # the while-read loop exits 1 at EOF; the scan itself continues
}

# --- (a) tracked tree --------------------------------------------------------
echo "secret-scan: tree scan of '$SCOPE' in $REPO"
COMBINED="$(printf '%s\n' "${PATTERNS[@]}" | paste -sd'|' -)"
check_stream "tree" < <(
  while IFS= read -r -d '' f; do
    # absolute path: git ls-files emits repo-root-relative paths, but the
    # caller's CWD may be anywhere
    grep -HnI -E -e "$COMBINED" -- "$REPO/$f" 2>/dev/null || true
  done < <(git -C "$REPO" ls-files -z -- "$SCOPE") \
    | while IFS= read -r hit; do
        p="${hit%%:*}"; r="${hit#*:}"; n="${r%%:*}"; t="${r#*:}"
        p="${p#$REPO/}"  # back to repo-root-relative for the allowlist
        printf '%s\034%s\034tree\034%s\n' "$p" "$n" "$t"
      done
)

# --- (b) full history --------------------------------------------------------
# Single-pass awk: matches the combined pattern with no per-line forks, so
# the full history stays fast. Only lines that match reach the per-pattern
# naming loop in check_stream.
if [[ "$SCAN_HISTORY" == "1" ]]; then
  echo "secret-scan: history scan of '$SCOPE' in $REPO"
  check_stream "history" < <(
    git -C "$REPO" log --format='__COMMIT__ %H' -p -- "$SCOPE" 2>/dev/null \
      | awk -v pat="$COMBINED" '
          /^__COMMIT__ / { commit=$2; next }
          /^\+\+\+ /      { file=substr($0, 7); sub(/^b\//, "", file); next }
          /^\+[^+]/      { line=substr($0, 2); if (line ~ pat) printf "%s\0340\034commit %s\034%s\n", file, commit, line }
        '
  )
fi

if [[ "$FINDINGS" -gt 0 ]]; then
  echo "secret-scan: FAIL — $FINDINGS unallowlisted finding(s)." >&2
  exit 1
fi
echo "secret-scan: PASS — no unallowlisted secrets in scope '$SCOPE'."
