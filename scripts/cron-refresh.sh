#!/bin/bash
# Run a full journal refresh. Install in crontab, e.g. every hour:
#   0 * * * * /Users/johndimm/projects/speak-memory/scripts/cron-refresh.sh >> /tmp/journal-refresh.log 2>&1

cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
/usr/bin/env node scripts/refresh.js
