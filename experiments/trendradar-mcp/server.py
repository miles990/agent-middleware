"""ai-trend MCP server — Path 1 skeleton.

Goal: expose Kuro's daily ai-trend opinions as MCP tools so any LLM client
(Claude Desktop, Cherry Studio, Codex CLI) can query archive + get source links.

License: MIT (this file). All code is fresh-written from FastMCP docs, NOT
copied from TrendRadar (GPL-3.0). TrendRadar inspired the tool taxonomy
only — see /tmp/trendradar-survey/mcp-findings.md.

Status: skeleton — tools return stub data. Wire to real archive next cycle.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from typing import Optional

from fastmcp import FastMCP

mcp = FastMCP("ai-trend")


@mcp.tool
async def resolve_date_range(expression: str) -> str:
    """Canonicalize natural-language date expressions to {start, end} ISO dates.

    Pre-resolve here so multiple LLM clients agree on what 'this week' means.
    Supported: today, yesterday, this-week, last-week, last-N-days, YYYY-MM-DD,
    YYYY-MM-DD..YYYY-MM-DD.
    """
    today = date.today()
    e = expression.strip().lower()

    if e in ("today",):
        s = today
    elif e in ("yesterday",):
        s = today - timedelta(days=1)
        return json.dumps({"start": s.isoformat(), "end": s.isoformat()})
    elif e in ("this-week", "this_week", "本周", "本週"):
        s = today - timedelta(days=today.weekday())
        return json.dumps({"start": s.isoformat(), "end": today.isoformat()})
    elif e in ("last-week", "last_week", "上周", "上週"):
        end = today - timedelta(days=today.weekday() + 1)
        s = end - timedelta(days=6)
        return json.dumps({"start": s.isoformat(), "end": end.isoformat()})
    elif m := re.fullmatch(r"last-(\d+)-days?", e):
        n = int(m.group(1))
        s = today - timedelta(days=n - 1)
        return json.dumps({"start": s.isoformat(), "end": today.isoformat()})
    elif m := re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})", e):
        return json.dumps({"start": m.group(1), "end": m.group(2)})
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", e):
        return json.dumps({"start": e, "end": e})
    else:
        return json.dumps({"error": f"unrecognized: {expression}"})

    return json.dumps({"start": s.isoformat(), "end": today.isoformat()})


@mcp.tool
async def query_archive(
    date_range: Optional[str] = None,
    topic: Optional[str] = None,
    limit: int = 20,
) -> str:
    """Query Kuro's ai-trend opinion archive.

    Args:
        date_range: ISO date or date..date or natural expr (call resolve_date_range first)
        topic: filter by topic tag (e.g. 'cs.MA', 'paper-opinion')
        limit: max entries

    Returns: JSON list of {date, title, opinion, source_url, kg_node_id?}.
    STUB — backed by real archive next cycle (target: kuro.page raw markdown).
    """
    # TODO(next-cycle): glob kuro.page repo for /posts/*.md, parse frontmatter,
    # filter by date_range/topic. For now, return shape-correct stub so clients
    # can be wired up.
    return json.dumps(
        {
            "status": "stub",
            "args": {"date_range": date_range, "topic": topic, "limit": limit},
            "entries": [],
            "note": "skeleton — real backend wiring is next cycle",
        },
        ensure_ascii=False,
    )


@mcp.tool
async def read_article(url: str) -> str:
    """Fetch article content via Jina Reader (r.jina.ai).

    Solves P2 #43: ai-trend posts cite source URLs but the LLM that wrote the
    opinion didn't have full content. This tool lets readers (or downstream
    agents) reify a citation back to its source markdown.

    Free tier: 100 RPM. Returns markdown.
    """
    import urllib.request

    req = urllib.request.Request(
        f"https://r.jina.ai/{url}",
        headers={"Accept": "text/markdown", "User-Agent": "kuro-ai-trend-mcp/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return json.dumps({"error": str(exc), "url": url})


if __name__ == "__main__":
    mcp.run()
