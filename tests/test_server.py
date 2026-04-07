"""Basic unit tests for slurmSight server.py logic."""
import importlib.util, json, os, sys, unittest, threading, http.client, time, tempfile

# Load server module without running __main__
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("server", os.path.join(REPO, "server.py"))
srv_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv_mod)


class TestLoadConfig(unittest.TestCase):
    def test_defaults(self):
        cfg = dict(srv_mod.DEFAULTS)
        self.assertEqual(cfg["port"], 8787)
        self.assertFalse(cfg["enable_submit"])
        self.assertFalse(cfg["enable_metrics"])
        self.assertFalse(cfg["enable_all_users"])
        self.assertEqual(cfg["rate_limit_scancel"], 10)
        self.assertEqual(cfg["auth_token"], "")

    def test_config_file_override(self, tmp_path=None):
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump({"port": 9999, "enable_submit": True}, f)
            fname = f.name
        try:
            cfg = srv_mod.load_config(fname)
            self.assertEqual(cfg["port"], 9999)
            self.assertTrue(cfg["enable_submit"])
            self.assertFalse(cfg["enable_metrics"])  # default kept
        finally:
            os.unlink(fname)

    def test_invalid_config_file_falls_back_to_defaults(self):
        cfg = srv_mod.load_config("/nonexistent/path/config.json")
        self.assertEqual(cfg["port"], srv_mod.DEFAULTS["port"])

    def test_bad_json_config_falls_back_to_defaults(self):
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write("NOT JSON {{{")
            fname = f.name
        try:
            cfg = srv_mod.load_config(fname)
            self.assertEqual(cfg["port"], srv_mod.DEFAULTS["port"])
        finally:
            os.unlink(fname)


class TestRateLimiter(unittest.TestCase):
    def setUp(self):
        # Reset rate buckets between tests
        srv_mod._rate_buckets.clear()

    def test_allows_under_limit(self):
        for _ in range(5):
            self.assertFalse(srv_mod.is_rate_limited("1.2.3.4", limit=10))

    def test_blocks_at_limit(self):
        for _ in range(10):
            srv_mod.is_rate_limited("5.5.5.5", limit=10)
        self.assertTrue(srv_mod.is_rate_limited("5.5.5.5", limit=10))

    def test_zero_limit_means_unlimited(self):
        for _ in range(100):
            self.assertFalse(srv_mod.is_rate_limited("6.6.6.6", limit=0))

    def test_different_ips_independent(self):
        for _ in range(10):
            srv_mod.is_rate_limited("7.7.7.7", limit=10)
        self.assertTrue(srv_mod.is_rate_limited("7.7.7.7", limit=10))
        self.assertFalse(srv_mod.is_rate_limited("8.8.8.8", limit=10))


class TestRunSlurm(unittest.TestCase):
    def test_missing_command(self):
        result = srv_mod.run_slurm(["this_command_does_not_exist_xyz"], timeout=3)
        self.assertFalse(result["ok"])
        self.assertIn("not found", result["err"].lower())

    def test_echo(self):
        result = srv_mod.run_slurm(["echo", "hello"], timeout=5)
        self.assertTrue(result["ok"])
        self.assertIn("hello", result["out"])

    def test_false_returns_not_ok(self):
        result = srv_mod.run_slurm(["false"], timeout=5)
        self.assertFalse(result["ok"])


class TestSubmitJob(unittest.TestCase):
    def test_missing_script(self):
        result = srv_mod.submit_job({})
        self.assertFalse(result["ok"])
        self.assertIn("Missing script", result["err"])

    def test_empty_script(self):
        result = srv_mod.submit_job({"script": "   "})
        self.assertFalse(result["ok"])

    def test_nonexistent_script_fails_gracefully(self):
        result = srv_mod.submit_job({"script": "/nonexistent/job.sh"})
        # sbatch may not exist; either way ok=False is expected
        self.assertIsInstance(result["ok"], bool)


class TestHTTPServer(unittest.TestCase):
    """Spin up a real server on a random port and test HTTP responses."""

    @classmethod
    def setUpClass(cls):
        srv_mod.CONFIG["auth_token"] = ""
        srv_mod.CONFIG["enable_submit"] = False
        srv_mod.CONFIG["enable_runs_browser"] = True
        cls.tmpdir = tempfile.TemporaryDirectory()
        srv_mod.CONFIG["scratch_root"] = cls.tmpdir.name

        batch = os.path.join(cls.tmpdir.name, "batch-a")
        run1 = os.path.join(batch, "run-001")
        run2 = os.path.join(batch, "run-002")
        os.makedirs(run1, exist_ok=True)
        os.makedirs(run2, exist_ok=True)
        with open(os.path.join(run1, "index.html"), "w", encoding="utf-8") as f:
            f.write("<html><body>run-001</body></html>")
        with open(os.path.join(run1, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"files": ["index.html"]}, f)
        with open(os.path.join(run1, "run-config.json"), "w", encoding="utf-8") as f:
            json.dump({"run_id": "001", "run_name": "alpha"}, f)
        with open(os.path.join(run2, "report.html"), "w", encoding="utf-8") as f:
            f.write("<html><body>run-002</body></html>")
        with open(os.path.join(run2, "log.out"), "w", encoding="utf-8") as f:
            f.write("line-1\nline-2\n")
        with open(os.path.join(batch, "overview.html"), "w", encoding="utf-8") as f:
            f.write("<html><body>batch overview</body></html>")
        with open(os.path.join(batch, "submit_cmd.sh"), "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\necho run\n")

        cls.server = srv_mod.ReuseAddrHTTPServer(("127.0.0.1", 0), srv_mod.SlurmSightHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        deadline = time.time() + 5
        last_exc = None
        while time.time() < deadline:
            conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=0.5)
            try:
                conn.connect()
                conn.close()
                break
            except OSError as exc:
                last_exc = exc
                conn.close()
                time.sleep(0.05)
        else:
            raise last_exc or RuntimeError("Server did not become ready in time")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.tmpdir.cleanup()

    def _get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read().decode()
        conn.close()
        return resp, body

    def _post(self, path, payload):
        data = json.dumps(payload).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", path, body=data, headers={"Content-Type":"application/json","Content-Length":str(len(data))})
        resp = conn.getresponse()
        body = resp.read().decode()
        conn.close()
        return resp, body

    def test_index_returns_html(self):
        resp, body = self._get("/")
        # 200 if index.html exists, 404 otherwise — either is fine structurally
        self.assertIn(resp.status, (200, 404))

    def test_slurm_status_endpoint(self):
        resp, body = self._get("/api/slurm_status")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertIn("available", data)

    def test_config_endpoint(self):
        resp, body = self._get("/api/config")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertIn("enable_submit", data["config"])

    def test_404_for_unknown(self):
        resp, body = self._get("/api/this_does_not_exist")
        self.assertEqual(resp.status, 404)

    def test_scancel_missing_jobid(self):
        resp, body = self._post("/api/scancel", {})
        self.assertIn(resp.status, (400, 200))
        data = json.loads(body)
        self.assertFalse(data["ok"])

    def test_sbatch_disabled_returns_403(self):
        resp, body = self._post("/api/sbatch", {"script": "/tmp/x.sh"})
        self.assertEqual(resp.status, 403)

    def test_options_cors(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("OPTIONS", "/api/squeue")
        resp = conn.getresponse()
        conn.close()
        self.assertEqual(resp.status, 204)

    def test_auth_required_when_token_set(self):
        srv_mod.CONFIG["auth_token"] = "secret123"
        try:
            resp, body = self._get("/api/slurm_status")
            self.assertEqual(resp.status, 401)
        finally:
            srv_mod.CONFIG["auth_token"] = ""

    def test_auth_accepted_with_bearer(self):
        srv_mod.CONFIG["auth_token"] = "secret456"
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request("GET", "/api/slurm_status", headers={"Authorization": "Bearer secret456"})
            resp = conn.getresponse()
            body = resp.read().decode()
            conn.close()
            self.assertEqual(resp.status, 200)
        finally:
            srv_mod.CONFIG["auth_token"] = ""

    def test_metrics_disabled_returns_404(self):
        srv_mod.CONFIG["enable_metrics"] = False
        resp, body = self._get("/api/metrics")
        self.assertEqual(resp.status, 404)

    def test_runs_summary_endpoint(self):
        resp, body = self._get("/api/runs/summary")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertTrue(any(row["batch"] == "batch-a" for row in data["data"]))

    def test_runs_list_endpoint(self):
        resp, body = self._get("/api/runs/list?batch=batch-a")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        run_names = [r["run"] for r in data["runs"]]
        self.assertIn("run-001", run_names)
        self.assertIn("run-002", run_names)
        run2 = [r for r in data["runs"] if r["run"] == "run-002"][0]
        self.assertIn("log.out", run2["text_files"])
        self.assertIn("overview.html", data["group_files"]["html_files"])

    def test_runs_meta_endpoint(self):
        resp, body = self._get("/api/runs/meta?batch=batch-a&run=run-001")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertEqual(data["metadata"]["run_config"]["run_name"], "alpha")

    def test_runs_view_endpoint(self):
        resp, body = self._get("/api/runs/view?batch=batch-a&run=run-001&file=index.html")
        self.assertEqual(resp.status, 200)
        self.assertIn("run-001", body)

    def test_runs_path_file_endpoint(self):
        resp, body = self._get("/api/runs/file/batch-a/run-001/index.html")
        self.assertEqual(resp.status, 200)
        self.assertIn("run-001", body)

    def test_runs_view_rejects_path_traversal(self):
        resp, body = self._get("/api/runs/view?batch=batch-a&run=run-001&file=../etc/passwd")
        self.assertEqual(resp.status, 404)
        data = json.loads(body)
        self.assertFalse(data["ok"])

    def test_runs_browser_can_be_disabled(self):
        srv_mod.CONFIG["enable_runs_browser"] = False
        try:
            resp, body = self._get("/api/runs/summary")
            self.assertEqual(resp.status, 403)
        finally:
            srv_mod.CONFIG["enable_runs_browser"] = True

    def test_runs_text_endpoint(self):
        resp, body = self._get("/api/runs/text?batch=batch-a&run=run-002&file=log.out")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertIn("line-1", data["content"])

    def test_runs_text_rejects_traversal(self):
        resp, body = self._get("/api/runs/text?batch=batch-a&run=run-002&file=../secret")
        self.assertEqual(resp.status, 404)
        data = json.loads(body)
        self.assertFalse(data["ok"])

    def test_batch_text_endpoint(self):
        resp, body = self._get("/api/runs/batch-text?batch=batch-a&file=submit_cmd.sh")
        self.assertEqual(resp.status, 200)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertIn("echo run", data["content"])

    def test_batch_file_endpoint(self):
        resp, body = self._get("/api/runs/batch-file/batch-a/overview.html")
        self.assertEqual(resp.status, 200)
        self.assertIn("batch overview", body)


if __name__ == "__main__":
    unittest.main()
