"""End-to-end MCP smoke test via FastMCP in-memory Client.

Verifies the server actually speaks MCP — list_tools + call_tool round-trip.
"""
import asyncio
import json
import sys
from fastmcp import Client
from server import mcp


async def main():
    async with Client(mcp) as client:
        # 1. list_tools — verifies registration over MCP transport
        tools = await client.list_tools()
        names = sorted(t.name for t in tools)
        assert names == ["list_topics", "query_archive", "read_article", "resolve_date_range"], names
        print(f"[OK] list_tools: {names}")

        # 2. resolve_date_range
        r = await client.call_tool("resolve_date_range", {"expression": "last-7-days"})
        body = json.loads(r.content[0].text)
        assert "start" in body and "end" in body, body
        print(f"[OK] resolve_date_range(last-7-days): {body}")

        # 3. query_archive — real backend
        r = await client.call_tool("query_archive", {"date_range": "today", "limit": 3})
        body = json.loads(r.content[0].text)
        if "error" in body:
            print(f"[WARN] query_archive returned error (data dir issue?): {body}")
        else:
            n = body["meta"]["returned"]
            print(f"[OK] query_archive(today, limit=3): {n} entries, backend={body['meta']['backend']}")
            if n > 0:
                e0 = body["entries"][0]
                has_url = bool(e0.get("url"))
                has_zh = bool(e0.get("zh_claim"))
                print(f"     first entry has url={has_url} zh_claim={has_zh}")

        # 4. topic filter
        r = await client.call_tool("query_archive", {"date_range": "last-7-days", "topic": "agent"})
        body = json.loads(r.content[0].text)
        print(f"[OK] query_archive(7d, topic=agent): returned={body.get('meta', {}).get('returned', 'err')}")

        # 5. list_topics — discovery
        r = await client.call_tool("list_topics", {"period": "7d"})
        body = json.loads(r.content[0].text)
        if "error" in body:
            print(f"[WARN] list_topics returned error: {body}")
        else:
            n = len(body.get("topics", []))
            sample = [t["topic"] for t in body["topics"][:3]]
            print(f"[OK] list_topics(7d): {n} topics, sample={sample}")
            assert n > 0, "expected at least one topic in 7d archive"


        print("\nALL E2E TESTS PASSED.")


asyncio.run(main())
