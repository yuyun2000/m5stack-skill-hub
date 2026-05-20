#!/usr/bin/env python3
"""Local LAN server for sharing Codex skills.

The server intentionally uses only Python's standard library so teammates can
run it without installing dependencies. It serves the frontend in public/ and
implements the /api/skills endpoints used by the page.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import posixpath
import re
import shutil
import sys
import time
import uuid
import zipfile
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlparse


MAX_UPLOAD_BYTES = 512 * 1024 * 1024
TEXT_FALLBACK_MIME = "text/plain; charset=utf-8"


@dataclass(frozen=True)
class ServerConfig:
    public_dir: Path
    data_dir: Path

    @property
    def skills_dir(self) -> Path:
        return self.data_dir / "skills"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"


class SkillShareHandler(SimpleHTTPRequestHandler):
    server_version = "SkillShare/1.0"
    config: ServerConfig

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "service": "skill-share"})
            return

        if parsed.path == "/api/skills":
            self.send_json({"skills": self.list_skills(include_markdown=False)})
            return

        skill_route = self.parse_skill_route(parsed.path)
        if skill_route:
            skill_id, action = skill_route
            if action == "detail":
                self.handle_skill_detail(skill_id)
                return
            if action == "files":
                self.handle_skill_files(skill_id)
                return
            if action == "download":
                self.handle_skill_download(skill_id)
                return
            if action == "comments":
                self.handle_get_comments(skill_id)
                return

        self.serve_static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/api/skills":
            self.handle_upload()
            return
        skill_route = self.parse_skill_route(parsed.path)
        if skill_route and skill_route[1] == "comments":
            self.handle_post_comment(skill_route[0])
            return
        self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        skill_route = self.parse_skill_route(parsed.path)
        if skill_route and skill_route[1] == "detail":
            self.handle_delete(skill_route[0])
            return
        self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def log_message(self, fmt: str, *args: Any) -> None:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write("[%s] %s\n" % (timestamp, fmt % args))

    def serve_static(self, request_path: str) -> None:
        public_dir = self.config.public_dir.resolve()
        decoded_path = unquote(request_path)
        if decoded_path == "/":
            decoded_path = "/index.html"

        normalized = posixpath.normpath(decoded_path).lstrip("/")
        if normalized.startswith("../"):
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        target = (public_dir / normalized).resolve()
        if not is_within(target, public_dir):
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if target.is_dir():
            target = target / "index.html"

        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        content = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def parse_skill_route(self, path: str) -> tuple[str, str] | None:
        prefix = "/api/skills/"
        if not path.startswith(prefix):
            return None

        rest = path[len(prefix) :].strip("/")
        if not rest:
            return None

        parts = rest.split("/")
        skill_id = unquote(parts[0])
        if len(parts) == 1:
            return skill_id, "detail"
        if len(parts) == 2 and parts[1] in {"files", "download", "comments"}:
            return skill_id, parts[1]
        return None

    def handle_upload(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Empty upload")
            return
        if content_length > MAX_UPLOAD_BYTES:
            self.send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large")
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Expected multipart/form-data")
            return

        body = self.rfile.read(content_length)
        try:
            form = parse_multipart(content_type, body)
            skill = self.save_uploaded_skill(form)
        except ValueError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        except Exception as exc:  # pragma: no cover - returned to client and logged.
            self.log_message("Upload failed: %s", exc)
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "Upload failed")
            return

        self.send_json({"skill": skill}, status=HTTPStatus.CREATED)

    def save_uploaded_skill(self, form: dict[str, Any]) -> dict[str, Any]:
        metadata = parse_json_field(form["fields"].get("metadata"), {})
        uploaded_files = form["files"]
        paths = form["fields"].get("paths", [])
        if isinstance(paths, str):
            paths = [paths]

        if not uploaded_files:
            raise ValueError("No files were uploaded")

        resolved_files: list[tuple[str, bytes, str]] = []
        for index, item in enumerate(uploaded_files):
            raw_path = paths[index] if index < len(paths) else item.get("filename") or f"file-{index}"
            relative_path = safe_relative_path(raw_path)
            resolved_files.append((relative_path, item["content"], item.get("content_type") or "application/octet-stream"))

        skill_markdown = find_uploaded_text(resolved_files, "SKILL.md")
        parsed = parse_skill_markdown(skill_markdown or "")

        name = clean_scalar(metadata.get("name")) or parsed.get("name") or clean_scalar(form["fields"].get("name")) or "未命名 Skill"
        folder_name = clean_scalar(metadata.get("folderName")) or safe_path_part(name)
        slug = unique_slug(name)
        now = iso_now()
        total_size = sum(len(content) for _, content, _ in resolved_files)

        skill_dir = self.config.skills_dir / slug
        tmp_dir = self.config.tmp_dir / f"{slug}-{uuid.uuid4().hex}"
        files_dir = tmp_dir / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        existing_comments = read_comments(skill_dir) if skill_dir.exists() else []

        for relative_path, content, _content_type in resolved_files:
            target = files_dir / Path(*PurePosixPath(relative_path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

        description = (
            clean_scalar(metadata.get("description"))
            or parsed.get("description")
            or "暂无简介。"
        )
        tags = normalize_tags(metadata.get("tags") or parsed.get("tags") or [])
        version = clean_scalar(metadata.get("version") or parsed.get("version"))

        saved_metadata = {
            "id": slug,
            "name": name,
            "folderName": folder_name,
            "description": description,
            "version": version,
            "tags": tags,
            "markdown": skill_markdown or clean_scalar(metadata.get("markdown")),
            "updatedAt": now,
            "fileCount": len(resolved_files),
            "size": total_size,
            "commentCount": len(existing_comments),
            "comments": existing_comments,
            "downloadUrl": f"/api/skills/{quote(slug)}/download",
        }

        (tmp_dir / "metadata.json").write_text(
            json.dumps(saved_metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        write_comments(tmp_dir, existing_comments)

        self.backup_skill(slug, "overwrite")
        if skill_dir.exists():
            shutil.rmtree(skill_dir)
        tmp_dir.replace(skill_dir)
        return saved_metadata

    def handle_skill_detail(self, skill_id: str) -> None:
        metadata = self.load_skill(skill_id, include_markdown=True)
        if not metadata:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return
        self.send_json({"skill": metadata})

    def handle_get_comments(self, skill_id: str) -> None:
        skill_dir = self.resolve_skill_dir(skill_id)
        if not skill_dir:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return

        comments = read_comments(skill_dir)
        self.send_json({"comments": comments, "commentCount": len(comments)})

    def handle_post_comment(self, skill_id: str) -> None:
        skill_dir = self.resolve_skill_dir(skill_id)
        if not skill_dir:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0 or content_length > 64 * 1024:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Invalid comment body")
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        author = clean_scalar(payload.get("author"))[:40] or "M5Stack 同事"
        body = clean_scalar(payload.get("body"))
        if not body:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Comment body is required")
            return
        if len(body) > 1200:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Comment is too long")
            return

        comments = read_comments(skill_dir)
        comment = {
            "id": uuid.uuid4().hex,
            "author": author,
            "body": body,
            "createdAt": iso_now(),
        }
        comments.append(comment)
        write_comments(skill_dir, comments)
        self.send_json({"comment": comment, "comments": comments, "commentCount": len(comments)}, status=HTTPStatus.CREATED)

    def handle_skill_files(self, skill_id: str) -> None:
        skill_dir = self.resolve_skill_dir(skill_id)
        if not skill_dir:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return

        files_dir = skill_dir / "files"
        files = []
        for path in sorted(files_dir.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(files_dir).as_posix()
            content = path.read_bytes()
            files.append(
                {
                    "path": relative,
                    "contentBase64": base64.b64encode(content).decode("ascii"),
                    "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                }
            )

        self.send_json({"files": files})

    def handle_skill_download(self, skill_id: str) -> None:
        metadata = self.load_skill(skill_id, include_markdown=False)
        skill_dir = self.resolve_skill_dir(skill_id)
        if not metadata or not skill_dir:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return

        zip_path = self.config.tmp_dir / f"{metadata['id']}-{uuid.uuid4().hex}.zip"
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            create_skill_zip(skill_dir, zip_path)
            content = zip_path.read_bytes()
        finally:
            if zip_path.exists():
                zip_path.unlink()

        filename = f"{safe_path_part(metadata.get('folderName') or metadata['name'])}.zip"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        self.wfile.write(content)

    def handle_delete(self, skill_id: str) -> None:
        skill_dir = self.resolve_skill_dir(skill_id)
        metadata = self.load_skill(skill_id, include_markdown=False)
        if not skill_dir or not metadata:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Skill not found")
            return

        backup_path = self.backup_skill(metadata["id"], "delete")
        shutil.rmtree(skill_dir)
        self.send_json(
            {
                "ok": True,
                "deleted": metadata["id"],
                "backupKept": bool(backup_path),
                "message": "Skill removed from shared list; backup retained on server.",
            }
        )

    def list_skills(self, include_markdown: bool) -> list[dict[str, Any]]:
        ensure_storage(self.config)
        skills = []
        for metadata_path in sorted(self.config.skills_dir.glob("*/metadata.json")):
            metadata = read_json(metadata_path)
            if not metadata:
                continue
            normalized = normalize_metadata(metadata)
            normalized["commentCount"] = len(read_comments(metadata_path.parent))
            if not include_markdown:
                normalized.pop("markdown", None)
            skills.append(normalized)
        return sorted(skills, key=lambda item: item.get("updatedAt", ""), reverse=True)

    def load_skill(self, skill_id: str, include_markdown: bool) -> dict[str, Any] | None:
        skill_dir = self.resolve_skill_dir(skill_id)
        if not skill_dir:
            return None
        metadata = read_json(skill_dir / "metadata.json")
        if not metadata:
            return None
        normalized = normalize_metadata(metadata)
        comments = read_comments(skill_dir)
        normalized["commentCount"] = len(comments)
        if include_markdown and not normalized.get("markdown"):
            skill_md = skill_dir / "files" / "SKILL.md"
            if skill_md.exists():
                normalized["markdown"] = skill_md.read_text(encoding="utf-8", errors="replace")
        if include_markdown:
            normalized["comments"] = comments
        if not include_markdown:
            normalized.pop("markdown", None)
        return normalized

    def resolve_skill_dir(self, skill_id: str) -> Path | None:
        ensure_storage(self.config)
        direct = (self.config.skills_dir / safe_path_part(skill_id)).resolve()
        skills_root = self.config.skills_dir.resolve()
        if is_within(direct, skills_root) and (direct / "metadata.json").exists():
            return direct

        for metadata_path in self.config.skills_dir.glob("*/metadata.json"):
            metadata = read_json(metadata_path)
            if not metadata:
                continue
            if skill_id in {metadata.get("id"), metadata.get("name"), metadata.get("folderName")}:
                return metadata_path.parent
        return None

    def backup_skill(self, slug: str, reason: str) -> Path | None:
        skill_dir = self.config.skills_dir / safe_path_part(slug)
        if not skill_dir.exists():
            return None

        backup_dir = self.config.backups_dir / safe_path_part(slug)
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"{timestamp_for_file()}-{uuid.uuid4().hex[:8]}-{reason}.zip"
        create_skill_zip(skill_dir, backup_path)
        return backup_path

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_error_json(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status=status)


def parse_multipart(content_type: str, body: bytes) -> dict[str, Any]:
    raw = (
        f"Content-Type: {content_type}\r\n"
        "MIME-Version: 1.0\r\n\r\n"
    ).encode("utf-8") + body
    message = BytesParser(policy=policy.default).parsebytes(raw)
    if not message.is_multipart():
        raise ValueError("Invalid multipart body")

    fields: dict[str, Any] = {}
    files: list[dict[str, Any]] = []
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue

        filename = part.get_filename()
        content = part.get_payload(decode=True) or b""
        if filename is None:
            value = content.decode(part.get_content_charset() or "utf-8", errors="replace")
            if name in fields:
                if not isinstance(fields[name], list):
                    fields[name] = [fields[name]]
                fields[name].append(value)
            else:
                fields[name] = value
        else:
            files.append(
                {
                    "field": name,
                    "filename": filename,
                    "content": content,
                    "content_type": part.get_content_type(),
                }
            )

    return {"fields": fields, "files": files}


def parse_json_field(value: Any, default: Any) -> Any:
    if not value:
        return default
    if isinstance(value, list):
        value = value[-1]
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def find_uploaded_text(files: list[tuple[str, bytes, str]], wanted_name: str) -> str:
    wanted = wanted_name.lower()
    for relative_path, content, _content_type in files:
        if PurePosixPath(relative_path).name.lower() == wanted:
            return content.decode("utf-8", errors="replace")
    return ""


def parse_skill_markdown(markdown: str) -> dict[str, Any]:
    frontmatter = parse_frontmatter(markdown)
    body = strip_frontmatter(markdown)
    heading_match = re.search(r"^#\s+(.+)$", body, flags=re.MULTILINE)
    first_paragraph = ""
    for part in re.split(r"\n{2,}", body):
        text = part.strip()
        if text and not text.startswith("#") and not text.startswith("|"):
            first_paragraph = text
            break

    return {
        "name": clean_scalar(frontmatter.get("name")) or (heading_match.group(1).strip() if heading_match else ""),
        "description": clean_scalar(frontmatter.get("description")) or summarize_text(first_paragraph),
        "version": clean_scalar(frontmatter.get("version")),
        "tags": extract_tags(markdown, frontmatter),
    }


def parse_frontmatter(markdown: str) -> dict[str, str]:
    match = re.match(r"^---\s*\n([\s\S]*?)\n---", markdown)
    if not match:
        return {}
    result: dict[str, str] = {}
    for line in match.group(1).splitlines():
        item = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if item:
            result[item.group(1)] = item.group(2).strip()
    return result


def extract_tags(markdown: str, frontmatter: dict[str, str]) -> list[str]:
    tags: list[str] = []
    raw_tags = clean_scalar(frontmatter.get("tags") or frontmatter.get("tag"))
    if raw_tags:
        tags.extend(part.strip() for part in raw_tags.strip("[]").split(","))

    section = useful_section(markdown)
    for line in section.splitlines():
        if re.match(r"^\s*[-*]\s+", line):
            tag = re.sub(r"^\s*[-*]\s+", "", line)
            tag = re.sub(r"[`*_]", "", tag).strip()
            tag = re.split(r"[。.!；;，,]", tag)[0].strip()
            if tag:
                tags.append(tag)

    return normalize_tags(tags)[:4]


def useful_section(markdown: str) -> str:
    lines = markdown.splitlines()
    start = -1
    for index, line in enumerate(lines):
        if re.match(r"^##+\s+(When to Use|功能|能力|适用|Capabilities|Usage)", line.strip(), re.I):
            start = index
            break
    if start == -1:
        return markdown
    collected = []
    for line in lines[start + 1 :]:
        if re.match(r"^##+\s+", line):
            break
        collected.append(line)
    return "\n".join(collected)


def strip_frontmatter(markdown: str) -> str:
    return re.sub(r"^---\s*\n[\s\S]*?\n---\s*", "", markdown).strip()


def summarize_text(text: str, limit: int = 120) -> str:
    cleaned = re.sub(r"[#>*`_-]", "", text or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1] + "…"


def safe_relative_path(raw_path: str) -> str:
    value = str(raw_path or "").replace("\\", "/").strip().lstrip("/")
    if not value:
        raise ValueError("Uploaded file has no relative path")

    path = PurePosixPath(value)
    if path.is_absolute():
        raise ValueError(f"Absolute paths are not allowed: {raw_path}")

    safe_parts = []
    for part in path.parts:
        if part in {"", ".", ".."} or re.match(r"^[A-Za-z]:$", part):
            raise ValueError(f"Unsafe file path: {raw_path}")
        safe_parts.append(safe_path_part(part))

    return PurePosixPath(*safe_parts).as_posix()


def safe_path_part(value: Any) -> str:
    text = str(value or "skill").strip()
    text = re.sub(r'[<>:"\\|?*\x00-\x1F]', "-", text)
    text = text.rstrip(". ")
    return text or "skill"


def unique_slug(name: str) -> str:
    text = safe_path_part(name).lower()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    text = text.strip("-")
    return text or f"skill-{uuid.uuid4().hex[:8]}"


def normalize_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        items = re.split(r"[,，]", value.strip("[]"))
    elif isinstance(value, list):
        items = value
    else:
        items = []

    tags: list[str] = []
    for item in items:
        tag = clean_scalar(item)
        if not tag:
            continue
        if len(tag) > 24:
            tag = tag[:23] + "…"
        if tag not in tags:
            tags.append(tag)
    return tags[:6]


def normalize_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    skill_id = clean_scalar(metadata.get("id")) or unique_slug(clean_scalar(metadata.get("name")) or "skill")
    download_url = clean_scalar(metadata.get("downloadUrl")) or f"/api/skills/{quote(skill_id)}/download"
    return {
        "id": skill_id,
        "name": clean_scalar(metadata.get("name")) or skill_id,
        "folderName": clean_scalar(metadata.get("folderName")) or clean_scalar(metadata.get("name")) or skill_id,
        "description": clean_scalar(metadata.get("description")) or "暂无简介。",
        "version": clean_scalar(metadata.get("version")),
        "tags": normalize_tags(metadata.get("tags")),
        "markdown": metadata.get("markdown") or "",
        "updatedAt": clean_scalar(metadata.get("updatedAt")) or iso_now(),
        "fileCount": int(metadata.get("fileCount") or 0),
        "size": int(metadata.get("size") or 0),
        "downloadUrl": download_url,
    }


def create_skill_zip(skill_dir: Path, zip_path: Path) -> None:
    files_dir = skill_dir / "files"
    metadata = read_json(skill_dir / "metadata.json") or {}
    top_folder = safe_path_part(metadata.get("folderName") or metadata.get("name") or skill_dir.name)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        metadata_path = skill_dir / "metadata.json"
        if metadata_path.exists():
            archive.write(metadata_path, f"{top_folder}/metadata.json")
        comments_path = skill_dir / "comments.json"
        if comments_path.exists():
            archive.write(comments_path, f"{top_folder}/comments.json")
        for path in sorted(files_dir.rglob("*")):
            if path.is_file():
                archive.write(path, f"{top_folder}/{path.relative_to(files_dir).as_posix()}")


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def read_comments(skill_dir: Path) -> list[dict[str, Any]]:
    path = skill_dir / "comments.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(raw, list):
        return []

    comments = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        body = clean_scalar(item.get("body"))
        if not body:
            continue
        comments.append(
            {
                "id": clean_scalar(item.get("id")) or uuid.uuid4().hex,
                "author": clean_scalar(item.get("author")) or "M5Stack 同事",
                "body": body,
                "createdAt": clean_scalar(item.get("createdAt")) or iso_now(),
            }
        )
    return comments


def write_comments(skill_dir: Path, comments: list[dict[str, Any]]) -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "comments.json").write_text(
        json.dumps(comments, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def clean_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return ""
    return str(value).strip().strip("\"'")


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def ensure_storage(config: ServerConfig) -> None:
    config.public_dir.mkdir(parents=True, exist_ok=True)
    config.skills_dir.mkdir(parents=True, exist_ok=True)
    config.backups_dir.mkdir(parents=True, exist_ok=True)
    config.tmp_dir.mkdir(parents=True, exist_ok=True)


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def timestamp_for_file() -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime())


def build_handler(config: ServerConfig) -> type[SkillShareHandler]:
    class ConfiguredSkillShareHandler(SkillShareHandler):
        pass

    ConfiguredSkillShareHandler.config = config
    return ConfiguredSkillShareHandler


def main() -> int:
    project_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Serve the Skill Share frontend and API")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=8888, help="Bind port")
    parser.add_argument("--public-dir", default=str(project_root / "public"), help="Frontend public directory")
    parser.add_argument("--data-dir", default=str(project_root / "server" / ".data"), help="Persistent server data directory")
    args = parser.parse_args()

    config = ServerConfig(
        public_dir=Path(args.public_dir).resolve(),
        data_dir=Path(args.data_dir).resolve(),
    )
    ensure_storage(config)

    handler = build_handler(config)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Skill Share service running at http://{args.host}:{args.port}", flush=True)
    print(f"Public directory: {config.public_dir}", flush=True)
    print(f"Data directory: {config.data_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Skill Share service...", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
