"""Map fai-browser's literal Node HTTP routes and source environment references.

Adapted from Subfloor's fastapi_endpoints.py reference. Owns dr_endpoint rows
with framework='fai-node' and dr_env rows for mapped src/ JavaScript files.
No JS is executed. Only the app's two explicit dispatch tables are supported;
computed routes, MCP stdio tools and injected arbitrary env objects are omitted.
Unsupported route patterns are reported rather than guessed. File failures
omit that file and are included in the map log. The mapper owns the transaction.
"""
import re

FRAMEWORK = "fai-node"
ROUTE = re.compile(
    r"^\s*\['(GET|POST|DELETE|PUT|PATCH|HEAD|OPTIONS)',\s*/\^(.*)\$/,\s*'([^']+)'",
    re.M,
)
ENV = re.compile(
    r"\bprocess\.env(?:\??\.([A-Za-z_][A-Za-z0-9_]*)|\[['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\])"
    r"|\benv\??\.(FAI_[A-Z0-9_]+)"
)


def route_path(pattern):
    """Represent the router's anonymous segment captures without naming them."""
    pattern = pattern.replace(r"\/", "/")
    for index in range(1, pattern.count("([^/]+)") + 1):
        pattern = pattern.replace("([^/]+)", "{param%d}" % index, 1)
    if not re.fullmatch(r"/[A-Za-z0-9_/{\}-]+", pattern):
        return None
    return pattern


def endpoints(rel, source):
    rows, omissions = [], []
    if rel == "src/daemon.js":
        block = re.search(r"const ROUTES = \[(.*?)\n  \];", source, re.S)
        if not block:
            return [], ["daemon ROUTES table missing"]
        for match in ROUTE.finditer(block.group(1)):
            path = route_path(match.group(2))
            if path:
                rows.append((match.group(1), path, match.group(3), FRAMEWORK, rel))
            else:
                omissions.append("unsupported route: " + match.group(2))
        expected = len(re.findall(r"^\s*\['[A-Z]+'", block.group(1), re.M))
        if expected != len(rows):
            omissions.append("daemon parsed %d/%d route rows" % (len(rows), expected))
    if rel == "src/bridge.js":
        block = re.search(r"const HTTP_ROUTES = \{(.*?)\n\};", source, re.S)
        if not block:
            return [], ["bridge HTTP_ROUTES table missing"]
        for path, handler in re.findall(r"^\s*'(/[^']+)':\s*'([^']+)'", block.group(1), re.M):
            rows.append(("POST", path, "handleHttp:" + handler, FRAMEWORK, rel))
            if handler == "commands":
                rows.append(("GET", path, "handleHttp:" + handler, FRAMEWORK, rel))
        # WebSocket upgrade is authenticated separately from the fallback HTTP table.
        ws = re.search(r"export const WS_PATH = '([^']+)'", source)
        if ws:
            rows.append(("GET", ws.group(1), "handleUpgrade (WebSocket)", FRAMEWORK, rel))
        else:
            omissions.append("bridge WS_PATH missing")
        if not rows:
            omissions.append("bridge routes unparseable")
    return rows, omissions


def extract(con, repo_root, cfg) -> str:
    con.execute("DELETE FROM dr_endpoint WHERE framework=?", (FRAMEWORK,))
    files = [r["path"] for r in con.execute(
        "SELECT path FROM dr_filepath WHERE path LIKE 'src/%' AND lang='JavaScript' ORDER BY path"
    )]
    # This source namespace belongs to this extractor, including files removed
    # since the last scan; leave environment rows from other areas untouched.
    con.execute("DELETE FROM dr_env WHERE source_file LIKE 'src/%'")
    routes = envs = 0
    omissions = []
    for rel in files:
        try:
            source = (repo_root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            omissions.append("%s: %s" % (rel, type(error).__name__))
            continue
        rows, skipped = endpoints(rel, source)
        omissions.extend(skipped)
        con.executemany(
            "INSERT INTO dr_endpoint(method,path,handler,framework,source_file) VALUES (?,?,?,?,?)", rows
        )
        routes += len(rows)
        # Discard whole-line comments; references in executable expressions,
        # including template expressions, are retained. This is best effort.
        code = "\n".join(line for line in source.splitlines()
                         if not line.lstrip().startswith(("//", "*", "/*")))
        names = sorted({next(v for v in match.groups() if v) for match in ENV.finditer(code)})
        con.executemany("INSERT INTO dr_env(name,source_file) VALUES (?,?)", [(n, rel) for n in names])
        envs += len(names)
    result = "%d endpoints, %d source env references; no product DB" % (routes, envs)
    if omissions:
        result += "; omissions: " + "; ".join(omissions)
    return result
