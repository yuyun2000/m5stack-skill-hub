from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from server.skill_share_server import ServerConfig, build_handler, form_from_skill_archive
from http.server import ThreadingHTTPServer


class SkillShareServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        public_dir = root / "public"
        public_dir.mkdir()
        (public_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")

        config = ServerConfig(public_dir=public_dir, data_dir=root / "data")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(config))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp_dir.cleanup()

    def request(
        self,
        path: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        method: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers or {},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()

    def make_skill_zip(self, folder: str = "demo-skill", name: str = "demo-skill") -> bytes:
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                f"{folder}/SKILL.md",
                "\n".join(
                    [
                        "---",
                        f"name: {name}",
                        "description: Demo Skill for API tests",
                        "version: 1.0.0",
                        "---",
                        "# Demo Skill",
                        "",
                        "Test instructions.",
                    ]
                ),
            )
            archive.writestr(f"{folder}/scripts/run.py", "print('ok')\n")
        return content.getvalue()

    def multipart_archive(self, archive: bytes) -> tuple[bytes, str]:
        boundary = "----SkillShareBoundary"
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode("ascii"))
        body.extend(b'Content-Disposition: form-data; name="archive"; filename="demo-skill.zip"\r\n')
        body.extend(b"Content-Type: application/zip\r\n\r\n")
        body.extend(archive)
        body.extend(f"\r\n--{boundary}--\r\n".encode("ascii"))
        return bytes(body), f"multipart/form-data; boundary={boundary}"

    def test_discovery_endpoints_are_self_describing(self) -> None:
        status, _headers, body = self.request("/llms.txt")
        self.assertEqual(status, 200)
        guide = body.decode("utf-8")
        self.assertIn("GET /api/skills", guide)
        self.assertIn("POST /api/skills/upload", guide)
        self.assertIn("GET /api/audit", guide)

        status, _headers, body = self.request("/api/manifest")
        manifest = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(manifest["agentEntry"], "/llms.txt")
        self.assertEqual(manifest["links"]["uploadZip"], "/api/skills/upload")

        status, _headers, body = self.request("/api/openapi.json")
        openapi = json.loads(body)
        self.assertEqual(status, 200)
        self.assertIn("/api/skills/upload", openapi["paths"])
        self.assertIn("/api/skills/{skill_id}/download", openapi["paths"])
        self.assertIn("/api/audit", openapi["paths"])
        self.assertIn("audit-log", manifest["capabilities"])

    def test_multipart_upload_list_detail_and_download_round_trip(self) -> None:
        upload_body, content_type = self.multipart_archive(self.make_skill_zip())
        status, _headers, body = self.request(
            "/api/skills/upload",
            data=upload_body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        upload = json.loads(body)
        self.assertEqual(status, 201)
        self.assertEqual(upload["skill"]["id"], "demo-skill")
        self.assertEqual(upload["links"]["download"], "/api/skills/demo-skill/download")

        status, _headers, body = self.request("/api/skills")
        catalog = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(catalog["count"], 1)
        self.assertEqual(catalog["skills"][0]["detailUrl"], "/api/skills/demo-skill")

        status, _headers, body = self.request("/api/skills/demo-skill")
        detail = json.loads(body)["skill"]
        self.assertEqual(status, 200)
        self.assertIn("# Demo Skill", detail["markdown"])

        status, headers, body = self.request("/api/skills/demo-skill/download")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(
                sorted(archive.namelist()),
                ["demo-skill/SKILL.md", "demo-skill/scripts/run.py"],
            )

        _status, _headers, body = self.request("/llms.txt")
        self.assertIn("id=demo-skill", body.decode("utf-8"))

    def test_raw_zip_upload_is_supported(self) -> None:
        status, _headers, body = self.request(
            "/api/skills/upload",
            data=self.make_skill_zip(folder="raw-skill", name="raw-skill"),
            headers={"Content-Type": "application/zip", "X-Skill-Folder": "raw-skill"},
            method="POST",
        )
        payload = json.loads(body)
        self.assertEqual(status, 201)
        self.assertEqual(payload["skill"]["id"], "raw-skill")

    def test_audit_log_records_lifecycle_and_filters(self) -> None:
        upload_body, content_type = self.multipart_archive(self.make_skill_zip())
        self.request(
            "/api/skills/upload",
            data=upload_body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        self.request("/api/skills/demo-skill/download")
        self.request(
            "/api/skills/demo-skill/comments",
            data=json.dumps({"author": "tester", "body": "内部备注不应写入日志"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        self.request(
            "/api/skills/upload",
            data=upload_body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        self.request("/api/skills/demo-skill", method="DELETE")

        status, _headers, body = self.request("/api/audit?limit=10")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["total"], 5)
        self.assertEqual(
            [item["event"] for item in payload["items"]],
            ["delete", "update", "comment", "download", "upload"],
        )
        self.assertEqual(payload["summary"]["upload"], 1)
        self.assertEqual(payload["summary"]["update"], 1)
        self.assertEqual(payload["summary"]["download"], 1)
        self.assertEqual(payload["summary"]["comment"], 1)
        self.assertEqual(payload["summary"]["delete"], 1)

        comment_item = next(item for item in payload["items"] if item["event"] == "comment")
        self.assertEqual(comment_item["detail"]["author"], "tester")
        self.assertNotIn("内部备注", json.dumps(comment_item, ensure_ascii=False))
        self.assertEqual(comment_item["skill"]["id"], "demo-skill")

        status, _headers, body = self.request("/api/audit?event=download")
        self.assertEqual(status, 200)
        filtered = json.loads(body)
        self.assertEqual(filtered["total"], 1)
        self.assertEqual(filtered["items"][0]["event"], "download")
        self.assertGreater(filtered["items"][0]["detail"]["size"], 0)

        status, _headers, body = self.request("/api/audit?skill=demo")
        self.assertEqual(json.loads(body)["total"], 5)

        status, _headers, body = self.request("/api/audit?limit=2&offset=3")
        page = json.loads(body)
        self.assertEqual(page["total"], 5)
        self.assertEqual(len(page["items"]), 2)

        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/api/audit?event=unknown")
        self.assertEqual(context.exception.code, 400)

    def test_archive_path_traversal_is_rejected(self) -> None:
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("../SKILL.md", "# unsafe")

        with self.assertRaisesRegex(ValueError, "Unsafe file path"):
            form_from_skill_archive(content.getvalue())

    def test_archive_with_multiple_top_level_skills_is_rejected(self) -> None:
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("first/SKILL.md", "# First")
            archive.writestr("second/SKILL.md", "# Second")

        with self.assertRaisesRegex(ValueError, "exactly one top-level Skill"):
            form_from_skill_archive(content.getvalue())


if __name__ == "__main__":
    unittest.main()
