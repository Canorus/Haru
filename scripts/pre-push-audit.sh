#!/bin/sh
set -eu

patterns='BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|haru_sc_[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|canor\.kr|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+'

if git grep -I -n -E "$patterns" -- . ':(exclude)scripts/pre-push-audit.sh'; then
  echo 'Potential secret or private deployment detail found.' >&2
  exit 1
fi

for path in $(git ls-files); do
  case "$path" in
    .env|.env.*|data/*.json|*.pem|*.key|*.p12|*.pfx)
      [ "$path" = '.env.example' ] && continue
      echo "Sensitive file is tracked: $path" >&2
      exit 1
      ;;
  esac
done

echo 'Pre-push sensitive-data audit passed.'
