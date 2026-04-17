#!/bin/bash
# Refresh an expired access token
# Usage: ./refresh-token.sh <refresh-token> <client-id> <client-secret> <token-file>

REFRESH_TOKEN="$1"
CLIENT_ID="$2"
CLIENT_SECRET="$3"
TOKEN_FILE="$4"

if [ -z "$REFRESH_TOKEN" ] || [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo '{"error": "missing_params"}' >&2
  exit 1
fi

RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "refresh_token=${REFRESH_TOKEN}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "grant_type=refresh_token")

if echo "$RESPONSE" | grep -q '"error"'; then
  echo "$RESPONSE" >&2
  exit 1
fi

# Update token file if provided
if [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  NEW_ACCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
  NEW_EXPIRY=$(echo "$RESPONSE" | python3 -c "import json,sys,time; d=json.load(sys.stdin); print(int(time.time())+d.get('expires_in',3600))")

  python3 -c "
import json, sys
with open('$TOKEN_FILE') as f:
    data = json.load(f)
data['access_token'] = '$NEW_ACCESS'
data['expires_at'] = $NEW_EXPIRY
with open('$TOKEN_FILE', 'w') as f:
    json.dump(data, f, indent=2)
print('Token refreshed, saved to $TOKEN_FILE')
"
else
  echo "$RESPONSE"
fi
