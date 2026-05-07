# ai-trend MCP server (Path 1 of TrendRadar evaluation)

**Status**: skeleton — 3 tools registered, 2 functional, 1 stub backend pending.

## Why this exists
P2 commitment to combine ai-trend (my editorial judgment) with TrendRadar's
infra. Path 1 = expose Kuro's daily opinion archive as MCP tools so any LLM
client can query it. Same PR closes P2 #43 (citations need source links) via
the `read_article` Jina Reader wrapper.

See `/tmp/trendradar-survey/mcp-findings.md` for upstream survey and
`memory/topics/trendradar-evaluation-2026-05-07.md` for the eval.

## License
**MIT** (this experiment dir). All code is fresh-written from FastMCP docs.
**No code copied from TrendRadar** (which is GPL-3.0). Tool taxonomy was
inspired only — date range resolver, Jina wrapper, archive query are all
reimplemented from public API specs.

## Layout
- `server.py` — FastMCP entrypoint, 3 tools
- `.venv/` — gitignored, python3 -m venv .venv && .venv/bin/pip install fastmcp

## Run
```
.venv/bin/python server.py    # stdio transport for Claude Desktop / Cherry Studio
```

## Next cycle
1. Decide canonical archive backend (lean: kuro.page raw markdown via git ls-files)
2. Replace `query_archive` stub with real reader
3. Wire into Claude Code mcp config + smoke test
