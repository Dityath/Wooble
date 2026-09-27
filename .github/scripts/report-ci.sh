#!/usr/bin/env bash
set -euo pipefail

title=$1
shift
failed=0

{
  printf '## %s\n\n' "$title"
  printf '| Check | Result |\n| --- | --- |\n'

  for entry in "$@"; do
    label=${entry%%=*}
    outcome=${entry#*=}

    case "$outcome" in
      success) result='✅ Passed' ;;
      failure) result='❌ Failed'; failed=1 ;;
      skipped) result='⏭️ Skipped'; failed=1 ;;
      cancelled) result='⚪ Cancelled'; failed=1 ;;
      *) result='❓ Unknown'; failed=1 ;;
    esac

    printf '| %s | %s |\n' "$label" "$result"
  done
} >> "$GITHUB_STEP_SUMMARY"

if (( failed )); then
  printf '::error title=%s failed::See the job summary and failed step for details.\n' "$title"
else
  printf '::notice title=%s passed::All checks completed successfully.\n' "$title"
fi
