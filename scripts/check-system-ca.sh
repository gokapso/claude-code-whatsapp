#!/bin/sh
set -eu

# Check the effective system bundle, including the alternate AAA cross-sign path.
# https://lists.debian.org/debian-security-announce/2026/msg00487.html
bundle=${1:-/etc/ssl/certs/ca-certificates.crt}
certificates=$(mktemp)
trap 'rm -f "$certificates"' EXIT HUP INT TERM
openssl crl2pkcs7 -nocrl -certfile "$bundle" -out "$certificates"
subjects=$(openssl pkcs7 -in "$certificates" -print_certs -noout)
if [ -z "$subjects" ]; then
  echo "No certificates found in $bundle" >&2
  exit 1
fi
if printf '%s\n' "$subjects" | grep -Eq 'CN[[:space:]]*=[[:space:]]*(emSign ECC Root CA - G3|AAA Certificate Services)([[:space:]]*,|$)'; then
  echo "Unsafe system CA bundle: install the vendor eMudhra/emSign trust-store update and rebuild." >&2
  exit 1
fi
echo "System CA bundle excludes the affected emSign and AAA trust anchors."
