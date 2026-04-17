#!/bin/bash
# Exchange authorization code for tokens
# Usage: ./exchange-token.sh <auth-code> <client-id> <client-secret> <redirect-uri> <output-file>

AUTH_CODE="$1"
CLIENT_ID="$2"
CLIENT_SECRET="$3"
REDIRECT_URI="$4"
OUTPUT_FILE="$5"

if [ -z "$AUTH_CODE" ] || [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo '{"error": "missing_params", "description": "Usage: exchange-token.sh <code> <client_id> <client_secret> <redirect_uri> <output_file>"}' >&2
  exit 1
fi

RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=${AUTH_CODE}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "redirect_uri=${REDIRECT_URI}" \
  -d "grant_type=authorization_code")

# Check for error
if echo "$RESPONSE" | grep -q '"error"'; then
  echo "$RESPONSE" >&2
  exit 1
fi

# Add metadata
ENRICHED=$(echo "$RESPONSE" | python3 -c "
import json, sys, time
data = json.load(sys.stdin)
data['obtained_at'] = int(time.time())
data['expires_at'] = int(time.time()) + data.get('expires_in', 3600)
json.dump(data, sys.stdout, indent=2)
")

if [ -n "$OUTPUT_FILE" ]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  echo "$ENRICHED" > "$OUTPUT_FILE"
  echo "Tokens saved to $OUTPUT_FILE"
else
  echo "$ENRICHED"
fi
