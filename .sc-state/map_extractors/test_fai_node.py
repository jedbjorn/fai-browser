"""Offline contract tests: python3 -m unittest discover -s .sc-state/map_extractors."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("fai_node", Path(__file__).with_name("fai_node.py"))
mapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mapper)


class ExtractorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()
        self.con = sqlite3.connect(":memory:")
        self.addCleanup(self.con.close)
        self.con.row_factory = sqlite3.Row
        self.con.executescript("""
            CREATE TABLE dr_filepath(path TEXT, lang TEXT);
            CREATE TABLE dr_endpoint(method,path,handler,framework,source_file);
            CREATE TABLE dr_env(name,source_file);
            INSERT INTO dr_endpoint VALUES ('GET','/other','other','unrelated','other.js');
            INSERT INTO dr_env VALUES ('KEEP','scripts/other.js');
        """)

    def source(self, name, content):
        (self.root / name).write_text(content)
        self.con.execute("INSERT INTO dr_filepath VALUES (?, 'JavaScript')", (name,))

    def rows(self, table):
        return [tuple(row) for row in self.con.execute("SELECT * FROM " + table)]

    def test_methods_parameters_and_repeat_refresh(self):
        self.source("src/daemon.js", r"""
  const ROUTES = [
    ['GET', /^\/v1\/sessions\/([^/]+)\/wakes\/([^/]+)$/, 'sessions.report'],
    ['POST', /^\/v1\/requests$/, 'requests.create'],
  ];
""")
        self.source("src/bridge.js", """
const HTTP_ROUTES = {
  '/commands': 'commands',
  '/results': 'result',
};
export const WS_PATH = '/ext/ws';
""")
        mapper.extract(self.con, self.root, {})
        endpoints = self.rows("dr_endpoint")
        self.assertEqual(len(endpoints), 7)
        self.assertIn(("GET", "/v1/sessions/{param1}/wakes/{param2}",
                       "sessions.report", "fai-node", "src/daemon.js"), endpoints)
        self.assertEqual({r[0] for r in endpoints if r[1] == "/commands"}, {"GET", "POST"})
        mapper.extract(self.con, self.root, {})
        self.assertEqual(self.rows("dr_endpoint"), endpoints)

    def test_environment_names_and_ownership(self):
        self.source("src/config.js", """
// process.env.COMMENT_ONLY
const values = [process.env.SystemRoot, process.env['HOME'], process.env?.PATH,
                env.FAI_HOME, process.env.HOME];
""")
        self.con.execute("INSERT INTO dr_env VALUES ('STALE', 'src/deleted.js')")
        mapper.extract(self.con, self.root, {})
        expected = [("KEEP", "scripts/other.js")] + [
            (name, "src/config.js") for name in ("FAI_HOME", "HOME", "PATH", "SystemRoot")
        ]
        self.assertEqual(self.rows("dr_env"), expected)
        mapper.extract(self.con, self.root, {})
        self.assertEqual(self.rows("dr_env"), expected)

    def test_removed_routes_and_bad_inputs_are_reported(self):
        self.con.execute("INSERT INTO dr_endpoint VALUES ('GET','/stale','stale','fai-node','src/deleted.js')")
        self.source("src/daemon.js", "const ROUTES = computedRoutes();")
        self.con.execute("INSERT INTO dr_filepath VALUES ('src/missing.js','JavaScript')")
        result = mapper.extract(self.con, self.root, {})
        self.assertIn("daemon ROUTES table missing", result)
        self.assertIn("src/missing.js: FileNotFoundError", result)
        self.assertEqual(len(self.rows("dr_endpoint")), 1)
        self.assertIsNone(mapper.route_path(r"\/v1\/(?:unsupported)"))
        self.assertTrue(mapper.endpoints("src/bridge.js", "broken")[1])


if __name__ == "__main__":
    unittest.main()
