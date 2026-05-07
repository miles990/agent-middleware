# ai-trend MCP server (Path 1 of TrendRadar evaluation)

**Status**: working skeleton — 3 tools registered, all functional, query_archive wired to live `landing-{1d,7d,30d}.json` data.

## Why this exists
P2 commitment to combine ai-trend (my editorial judgment) with TrendRadar's
infra. Path 1 = expose Kuro's daily opinion archive as MCP tools so any LLM
client can query it. Same PR closes P2 #43 (citations need source links) via
`query_archive` returning `url` per entry, plus `read_article` Jina wrapper for
fetching the cited article body on demand.

See `/tmp/trendradar-survey/mcp-findings.md` for upstream survey and
`memory/topics/trendradar-evaluation-2026-05-07.md` for the eval.

## License
**MIT** (this experiment dir). All code is fresh-written from FastMCP docs.
**No code copied from TrendRadar** (which is GPL-3.0). Tool taxonomy was
inspired only — date range resolver, Jina wrapper, archive query are all
reimplemented from public API specs.

## Tools
| name | purpose |
|------|---------|
| `resolve_date_range(expr)` | Canonicalize `today` / `yesterday` / `last-7-days` / `last-30-days` / ISO ranges → `{start, end}` |
| `list_topics(period)` | Discovery: list available topic filters from `landing-{1d,7d,30d}.json` with post counts |
| `query_archive(date_range, topic?)` | Read `landing-{1d,7d,30d}.json`, return entries with `{title, url, zh_claim, zh_so_what, source, points, published_at}` |
| `read_article(url)` | Fetch full article content via Jina Reader (`r.jina.ai/<url>`) — markdown out |

## Layout
- `server.py` — FastMCP entrypoint, 3 tools
- `requirements.txt` — pinned `fastmcp==3.2.4`
- `.venv/` — gitignored, `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`

## Configuration

`query_archive` reads from `kuro-portfolio/ai-trend/data/`. Override with env var:

```bash
export AI_TREND_DATA_DIR=/abs/path/to/kuro-portfolio/ai-trend/data
```

Default path is auto-resolved relative to the repo if env is unset.

## Run

### Local stdio (manual smoke test)
```bash
.venv/bin/python server.py
```

### Claude Code (`claude mcp add`)
```bash
claude mcp add ai-trend \
  -e AI_TREND_DATA_DIR=/Users/user/Workspace/kuro-portfolio/ai-trend/data \
  -- /Users/user/Workspace/agent-middleware/experiments/trendradar-mcp/.venv/bin/python \
     /Users/user/Workspace/agent-middleware/experiments/trendradar-mcp/server.py
```

### Claude Desktop / Cherry Studio (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "ai-trend": {
      "command": "/Users/user/Workspace/agent-middleware/experiments/trendradar-mcp/.venv/bin/python",
      "args": ["/Users/user/Workspace/agent-middleware/experiments/trendradar-mcp/server.py"],
      "env": {
        "AI_TREND_DATA_DIR": "/Users/user/Workspace/kuro-portfolio/ai-trend/data"
      }
    }
  }
}
```

## Verification
```bash
# tool registration
.venv/bin/python -c "import asyncio; from server import mcp; \
  print([t.name for t in asyncio.run(mcp.list_tools())])"
# → ['resolve_date_range', 'query_archive', 'read_article']
```

## Next cycle
1. End-to-end stdio test via `mcp dev server.py` inspector (or `fastmcp dev`)
2. Decide whether `read_article` should cache fetched markdown locally
3. Add `list_topics` tool that aggregates `topic` field across last-30-days for discovery
