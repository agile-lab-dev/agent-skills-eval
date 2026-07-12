"""Tests for scripts.utils.sanitize_name and the path-containment guard in
scripts.run_eval, covering the path-traversal fix for run_single_query.

Run with: python -m unittest scripts.test_utils   (from the skill-creator directory)
"""

import tempfile
import unittest
import uuid
from pathlib import Path

from scripts.run_eval import _ensure_within
from scripts.utils import parse_skill_md, sanitize_name


class SanitizeNameTests(unittest.TestCase):
    def test_strips_path_traversal_segments(self):
        cleaned = sanitize_name("../../etc/passwd")
        self.assertNotIn("/", cleaned)
        self.assertNotIn("..", cleaned)

    def test_leaves_already_safe_names_unchanged(self):
        self.assertEqual(sanitize_name("my-skill_v2"), "my-skill_v2")

    def test_empty_string_falls_back(self):
        self.assertEqual(sanitize_name(""), "skill")

    def test_all_invalid_chars_falls_back(self):
        self.assertEqual(sanitize_name("///"), "skill")
        self.assertEqual(sanitize_name("..."), "skill")

    def test_unicode_and_whitespace_replaced(self):
        cleaned = sanitize_name("skïll näme \U0001F600")
        self.assertRegex(cleaned, r"^[a-zA-Z0-9_-]+$")

    def test_custom_fallback(self):
        self.assertEqual(sanitize_name("///", fallback="x"), "x")


class PathBuildingIntegrationTests(unittest.TestCase):
    """Reproduces run_single_query's path construction with a malicious
    SKILL.md `name:` to confirm the resulting command_file cannot escape
    project_commands_dir.
    """

    def _write_skill_md(self, tmp_path: Path, name: str) -> Path:
        skill_dir = tmp_path / "some-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            f'---\nname: "{name}"\ndescription: test\n---\n\nBody.\n'
        )
        return skill_dir

    def test_traversal_name_is_contained(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            skill_dir = self._write_skill_md(tmp_path, "../../../tmp/evil")
            name, _, _ = parse_skill_md(skill_dir)

            project_commands_dir = tmp_path / ".claude" / "commands"
            project_commands_dir.mkdir(parents=True)

            safe_name = sanitize_name(name)
            clean_name = f"{safe_name}-skill-{uuid.uuid4().hex[:8]}"
            command_file = project_commands_dir / f"{clean_name}.md"

            resolved = _ensure_within(command_file, project_commands_dir)
            self.assertEqual(resolved.parent, project_commands_dir.resolve())

    def test_ensure_within_raises_for_escaping_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            project_commands_dir = tmp_path / ".claude" / "commands"
            project_commands_dir.mkdir(parents=True)

            escaping_path = tmp_path / "outside.md"
            with self.assertRaises(ValueError):
                _ensure_within(escaping_path, project_commands_dir)

    def test_ensure_within_allows_contained_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            project_commands_dir = tmp_path / ".claude" / "commands"
            project_commands_dir.mkdir(parents=True)

            inside_path = project_commands_dir / "fine.md"
            # Should not raise.
            _ensure_within(inside_path, project_commands_dir)


if __name__ == "__main__":
    unittest.main()
