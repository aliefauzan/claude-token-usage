#!/usr/bin/env python3
"""Claude Code usage by local day, counted the way /stats counts it.

/stats reads ~/.claude/stats-cache.json, which Claude Code keeps up to its
`lastComputedDate`, and counts later days from the transcripts. Its rules:
every transcript line that carries usage is added (a reply saved as several
lines counts once per line), subagent transcripts included, and each
transcript's whole usage is filed under the local day its session started.
This script does the same: days up to `lastComputedDate` come from the cache
file, later days from the transcripts under ~/.claude/projects.

The cache file has one token total per model per day; the split into input,
output, cache read and cache write is taken from that day's transcripts where
they still exist, else from the model's all-time split in the cache file.

Prints JSON:
  {"today": "YYYY-MM-DD",
   "meta": {"firstDay", "firstSessionAt", "longestSessionMs", "statsThrough",
            "hours": {"0".."23": sessions started}},
   "days": {"YYYY-MM-DD": {
       "t": [input, output, cache_read, cache_write],
       "msgs": messages, "sess": sessions, "h": {"hour": sessions started},
       "m": {"model": [input, output, cache_read, cache_write]},
       "c": estimated USD at API list prices, "mc": {"model": USD},
       "f" / "p" / "s": {"feature" / "project" / "surface": tokens} from the
           transcripts (shares of the day; days with no transcripts lack them),
       "tl": {"tool": calls}, "r": {"model": replies}}},
   "chats": [{"id", "title", "project", "surface", "day", "model", "tokens",
              "cost", "subagents", "msgs"}]}  (every chat of the last 31 days
           and the 40 largest before them)
A per-file cache keyed on size + mtime makes refreshes incremental.
"""
import json, os, time
from datetime import datetime, timedelta

HOME = os.path.expanduser("~/.claude")
ROOT = os.path.expanduser(os.environ.get("TOKEN_USAGE_ROOT", os.path.join(HOME, "projects")))
STATS = os.path.expanduser(os.environ.get("TOKEN_USAGE_STATS", os.path.join(HOME, "stats-cache.json")))
CACHE = os.path.expanduser("~/.cache/claude-token-usage/cache-v5.json")
start = time.time()

# USD per million tokens: input, output, cache read. A cache write costs
# 1.25x input (5-minute TTL) or 2x input (1-hour TTL). Anthropic API list
# prices; a subscription plan bills differently, so this is an estimate.
PRICES = [
    ("fable-5-2", 8, 40, 0.20), ("mythos-5-2", 8, 40, 0.20),
    ("fable-5-1", 10, 50, 0.25), ("mythos-5-1", 10, 50, 0.25),
    ("fable-5", 10, 50, 1.00), ("mythos-5", 10, 50, 1.00),
    ("opus-5-5", 4, 20, 0.20), ("opus-5", 5, 25, 0.50),
    ("opus-4-8", 5, 25, 0.50), ("opus-4-7", 5, 25, 0.50),
    ("opus-4-6", 5, 25, 0.50), ("opus-4-5", 5, 25, 0.50),
    ("opus-4-1", 15, 75, 1.50), ("opus-4", 15, 75, 1.50), ("3-opus", 15, 75, 1.50),
    ("sonnet-5-5", 2, 10, 0.10), ("sonnet-5", 2, 10, 0.20),
    ("sonnet-4", 3, 15, 0.30), ("3-7-sonnet", 3, 15, 0.30), ("3-5-sonnet", 3, 15, 0.30),
    ("haiku-5-5", 0.10, 0.50, 0.01), ("haiku-4-5", 1, 5, 0.10),
    ("3-5-haiku", 0.80, 4, 0.08), ("3-haiku", 0.25, 1.25, 0.03),
    # family fallbacks for Claude ids not listed above
    ("claude-fable", 8, 40, 0.20), ("claude-mythos", 8, 40, 0.20),
    ("claude-opus", 4, 20, 0.20), ("claude-sonnet", 2, 10, 0.10), ("claude-haiku", 0.10, 0.50, 0.01),
]


def price(model):
    for key, i, o, r in PRICES:
        if key in model:
            return i, o, r
    return 0, 0, 0


def cost(model, quad, share_1h):
    i, o, r = price(model)
    inp, out, read, write = quad
    write_rate = i * (2 * share_1h + 1.25 * (1 - share_1h))
    return (inp * i + out * o + read * r + write * write_rate) / 1e6


def local(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        return None


def parse_file(path):
    """One transcript: when it started and ended, its lines, and its usage by model."""
    first = last = None
    lines = 0
    models = {}
    tools = {}
    replies = {}   # model -> set of message ids
    title = prompt = cwd = entry = origin = None
    try:
        fh = open(path, "rb")
    except OSError:
        return None
    with fh:
        for raw in fh:
            if b'"custom-title"' in raw and b'"timestamp"' not in raw:
                try:
                    title = json.loads(raw).get("customTitle") or title
                except ValueError:
                    pass
                continue
            if b'"timestamp"' not in raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if cwd is None and row.get("cwd"):
                cwd = row["cwd"]
            if entry is None and row.get("entrypoint"):
                entry = row["entrypoint"]
            if row.get("type") == "user" and origin is None and row.get("turnOrigin"):
                origin = row["turnOrigin"]
            if prompt is None and row.get("type") == "user" and row.get("turnOrigin") in (None, "human", "sdk"):
                prompt = first_text((row.get("message") or {}).get("content"))
            when = local(row.get("timestamp"))
            if when is None:
                continue
            if first is None:
                first = when
            last = when
            lines += 1
            if row.get("type") != "assistant":
                continue
            msg = row.get("message")
            if not isinstance(msg, dict):
                continue
            u = msg.get("usage")
            model = msg.get("model") or "?"
            for block in msg.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    name = tool_name(block.get("name") or "?")
                    tools[name] = tools.get(name, 0) + 1
            if not isinstance(u, dict) or model == "<synthetic>":
                continue
            replies.setdefault(model, set()).add(msg.get("id") or row.get("uuid"))
            acc = models.setdefault(model, [0, 0, 0, 0, 0])
            acc[0] += int(u.get("input_tokens") or 0)
            acc[1] += int(u.get("output_tokens") or 0)
            acc[2] += int(u.get("cache_read_input_tokens") or 0)
            acc[3] += int(u.get("cache_creation_input_tokens") or 0)
            acc[4] += int(((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens")) or 0)
    if first is None:
        return None
    return {
        "day": first.strftime("%Y-%m-%d"), "hour": first.hour,
        "ms": int((last - first).total_seconds() * 1000),
        "lines": lines, "m": models, "tools": tools,
        "replies": {k: len(v) for k, v in replies.items()},
        "title": title, "prompt": prompt, "cwd": cwd, "entry": entry, "origin": origin,
    }


def first_text(content):
    """The words a person typed, without system reminders; None for tool results."""
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        texts = [b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") == "text"]
    else:
        return None
    for t in texts:
        t = t.strip()
        if not t or t.startswith("<"):
            continue
        return " ".join(t.split())[:90]
    return None


def tool_name(name):
    """MCP tools by their server, so one server reads as one tool family."""
    if name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1] if len(parts) > 1 else name
        server = server.replace("plugin_", "").replace("claude_ai_", "")
        return "MCP: " + server
    return name


SURFACES = {"claude-desktop": "Desktop app", "cli": "CLI", "claude-vscode": "VS Code",
            "sdk-ts": "SDK", "sdk-py": "SDK", "sdk-cli": "SDK", "remote": "Cloud"}


def project_of(cwd):
    if not cwd:
        return "Unknown"
    if "scratch-workspaces" in cwd:
        return "No folder"
    # A worktree counts toward the repository it was cut from.
    for marker in ("/.claude/worktrees/", "/.worktrees/", "/worktrees/"):
        if marker in cwd:
            cwd = cwd.split(marker)[0]
            break
    return os.path.basename(cwd.rstrip("/")) or cwd


def scan():
    try:
        with open(CACHE) as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        cache = {}
    fresh, scanned = {}, 0
    for dirpath, _dirs, files in os.walk(ROOT):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            sig = [st.st_size, int(st.st_mtime)]
            hit = cache.get(path)
            if hit and hit.get("sig") == sig:
                fresh[path] = hit
            else:
                fresh[path] = {"sig": sig, "f": parse_file(path)}
                scanned += 1
    if scanned or len(fresh) != len(cache):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(fresh, fh, separators=(",", ":"))
        os.replace(tmp, CACHE)
    return {p: e["f"] for p, e in fresh.items() if e.get("f")}, scanned


def add(acc, nums):
    for i in range(len(acc)):
        acc[i] += nums[i]


def main():
    files, scanned = scan()
    try:
        with open(STATS) as fh:
            stats = json.load(fh)
    except (OSError, ValueError):
        stats = {}
    last = stats.get("lastComputedDate") or ""

    # What the transcripts hold, filed under each session's start day.
    by_day = {}      # day -> model -> [in, out, read, write, write_1h]
    live = {}        # day -> {"msgs", "sess", "h"} for days after `last`
    share_1h = {}    # model -> [write_1h, write]
    longest = 0
    hours_live = {}
    for path, f in files.items():
        is_sub = "/subagents/" in path
        day = f["day"]
        models = by_day.setdefault(day, {})
        for model, q in f["m"].items():
            add(models.setdefault(model, [0, 0, 0, 0, 0]), q)
            s = share_1h.setdefault(model, [0, 0])
            s[0] += q[4]
            s[1] += q[3]
        if day > last:
            d = live.setdefault(day, {"msgs": 0, "sess": 0, "h": {}})
            d["msgs"] += f["lines"]
            if not is_sub:
                d["sess"] += 1
                hour = str(f["hour"])
                d["h"][hour] = d["h"].get(hour, 0) + 1
                hours_live[hour] = hours_live.get(hour, 0) + 1
                longest = max(longest, f["ms"])

    def ratio_1h(model):
        s = share_1h.get(model)
        return s[0] / s[1] if s and s[1] else 1.0

    # Each model's all-time split, for days whose transcripts are gone.
    model_split = {}
    for model, u in (stats.get("modelUsage") or {}).items():
        model_split[model] = [
            u.get("inputTokens", 0), u.get("outputTokens", 0),
            u.get("cacheReadInputTokens", 0), u.get("cacheCreationInputTokens", 0),
        ]

    def split(total, *candidates):
        for q in candidates:
            if q and sum(q[:4]) > 0:
                s = sum(q[:4])
                parts = [round(total * x / s) for x in q[:4]]
                parts[2] += total - sum(parts)
                return parts
        return [0, 0, total, 0]

    days = {}

    def day_of(d):
        if d not in days:
            days[d] = {"t": [0, 0, 0, 0], "msgs": 0, "sess": 0, "h": {}, "m": {}, "c": 0.0, "mc": {}}
        return days[d]

    def put(d, model, quad):
        e = day_of(d)
        add(e["t"], quad)
        add(e["m"].setdefault(model, [0, 0, 0, 0]), quad)
        usd = cost(model, quad, ratio_1h(model))
        e["c"] += usd
        e["mc"][model] = e["mc"].get(model, 0.0) + usd

    # Days up to `last`: the cache file /stats reads.
    for row in stats.get("dailyModelTokens") or []:
        d = row.get("date")
        if not d or d > last:
            continue
        for model, total in (row.get("tokensByModel") or {}).items():
            put(d, model, split(int(total), by_day.get(d, {}).get(model), model_split.get(model)))
    for row in stats.get("dailyActivity") or []:
        d = row.get("date")
        if not d or d > last:
            continue
        e = day_of(d)
        e["msgs"] = int(row.get("messageCount") or 0)
        e["sess"] = int(row.get("sessionCount") or 0)
    for d, models in by_day.items():
        if d <= last or not d:
            continue
        for model, q in models.items():
            put(d, model, q[:4])
    for d, a in live.items():
        e = day_of(d)
        e["msgs"], e["sess"], e["h"] = a["msgs"], a["sess"], a["h"]

    # Per-day start hours where the cache file has none: from the transcripts.
    for path, f in files.items():
        if "/subagents/" in path or f["day"] > last or f["day"] not in days:
            continue
        h = days[f["day"]]["h"]
        h[str(f["hour"])] = h.get(str(f["hour"]), 0) + 1

    # Breakdowns the cache file does not keep: from the transcripts.
    chats = {}
    for path, f in files.items():
        is_sub = "/subagents/" in path
        d = f["day"]
        if d not in days:
            continue
        e = days[d]
        tokens = sum(sum(q[:4]) for q in f["m"].values())
        usd = sum(cost(m, q[:4], ratio_1h(m)) for m, q in f["m"].items())
        if is_sub:
            feature = "Subagents"
        elif f.get("origin") == "scheduled":
            feature = "Scheduled"
        else:
            feature = "Chats"
        project = project_of(f.get("cwd"))
        surface = SURFACES.get(f.get("entry") or "", f.get("entry") or "Unknown")
        for key, name in (("f", feature), ("p", project), ("s", surface)):
            if tokens:
                bucket = e.setdefault(key, {})
                bucket[name] = bucket.get(name, 0) + tokens
        for name, n in (f.get("tools") or {}).items():
            tl = e.setdefault("tl", {})
            tl[name] = tl.get(name, 0) + n
        for model, n in (f.get("replies") or {}).items():
            r = e.setdefault("r", {})
            r[model] = r.get(model, 0) + n

        parts = path.split(os.sep)
        sid = parts[-3] if is_sub else os.path.splitext(parts[-1])[0]
        c = chats.setdefault(sid, {"id": sid, "title": None, "prompt": None, "project": project,
                                   "surface": surface, "day": d, "m": {}, "tokens": 0, "cost": 0.0,
                                   "subagents": 0, "msgs": 0})
        c["tokens"] += tokens
        c["cost"] += usd
        c["msgs"] += f["lines"]
        for model, q in f["m"].items():
            c["m"][model] = c["m"].get(model, 0) + sum(q[:4])
        if is_sub:
            c["subagents"] += 1
        else:
            c["day"], c["project"], c["surface"] = d, project, surface
            c["title"], c["prompt"] = f.get("title"), f.get("prompt")

    recent = sorted(days)[-31:] if days else []
    since = (datetime.now().astimezone() - timedelta(days=31)).strftime("%Y-%m-%d")
    out_chats = []
    for c in chats.values():
        if not c["tokens"]:
            continue
        c["model"] = max(c["m"], key=c["m"].get) if c["m"] else "?"
        c["title"] = c["title"] or c["prompt"] or "Untitled chat"
        c["cost"] = round(c["cost"], 4)
        del c["m"], c["prompt"]
        out_chats.append(c)
    out_chats.sort(key=lambda c: -c["tokens"])
    keep = [c for c in out_chats if c["day"] >= since]
    keep += [c for c in out_chats if c["day"] < since][:40]
    del recent

    for e in days.values():
        e["c"] = round(e["c"], 4)
        e["mc"] = {k: round(v, 4) for k, v in e["mc"].items()}

    hours = {str(k): int(v) for k, v in (stats.get("hourCounts") or {}).items()}
    for k, v in hours_live.items():
        hours[k] = hours.get(k, 0) + v
    first_day = None
    when = local(stats.get("firstSessionDate"))
    if when:
        first_day = when.strftime("%Y-%m-%d")
    elif days:
        first_day = min(days)
    longest = max(longest, int((stats.get("longestSession") or {}).get("duration") or 0))

    print(json.dumps({
        "today": datetime.now().strftime("%Y-%m-%d"),
        "meta": {"firstDay": first_day, "firstSessionAt": stats.get("firstSessionDate") or (first_day and first_day + "T00:00:00"),
                 "longestSessionMs": longest, "hours": hours, "statsThrough": last},
        "days": days, "chats": keep, "scanned": scanned,
        "ms": int((time.time() - start) * 1000),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
