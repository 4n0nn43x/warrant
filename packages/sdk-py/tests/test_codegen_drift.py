"""The test that makes generation safe.

Without it, `_generated.py` is an artifact that can fall asleep: someone adds a
field to `schemas.ts`, the Python keeps importing, the TypeScript and Python
agents diverge, and nobody knows until a Python agent refuses an argument the MCP
server accepts.

With it, drift is a red CI. That is the price — and the whole price — of
generating rather than reading at runtime: see the header of `codegen/emit.ts`.

The test skips cleanly when `tsx` is unavailable (wheel installed from PyPI,
without the repository). It **never** skips in CI, where the monorepo is present:
a test that silently skips where it matters protects nothing.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
EMIT = REPO / "packages" / "sdk-py" / "codegen" / "emit.ts"
TSX = REPO / "node_modules" / ".bin" / "tsx"


def _runner() -> list[str] | None:
    if TSX.exists():
        return [str(TSX)]
    if shutil.which("pnpm"):
        return ["pnpm", "--silent", "tsx"]
    if shutil.which("npx"):
        return ["npx", "--yes", "tsx"]
    return None


@pytest.mark.skipif(not EMIT.exists(), reason="outside the monorepo: no generator to compare against")
def test_generated_artifacts_match_the_typescript_source() -> None:
    """Regenerate everything in memory and compare, byte for byte.

    Covers all four artefacts at once — the Python models, the frozen manifest, the
    OpenAPI snapshot and the OpenClaw ``SKILL.md`` — because all four are projections
    of the same source and any one of them going stale is the same bug.
    """
    runner = _runner()
    if runner is None:
        pytest.skip("no tsx, no pnpm, no npx: cannot replay the generator")

    result = subprocess.run(  # noqa: S603 — command built here, not received
        [*runner, str(EMIT), "--check"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert result.returncode == 0, (
        "The generated artifacts have drifted from the single source of truth.\n\n"
        f"{result.stderr or result.stdout}\n"
        "Regenerate: pnpm tsx packages/sdk-py/codegen/emit.ts"
    )


def test_generated_module_carries_a_do_not_edit_banner() -> None:
    """A generated file that does not say so gets hand-edited eventually."""
    source = (REPO / "packages" / "sdk-py" / "src" / "warrant_sdk" / "_generated.py").read_text(
        encoding="utf-8"
    )
    assert "GENERATED FILE" in source
    assert "codegen/emit.ts" in source


def test_skill_declares_the_manifest_it_was_built_from() -> None:
    """A stale skill must be detectable without reading any code."""
    from warrant_sdk import MANIFEST_SHA256

    skill = (REPO / "skills" / "warrant" / "SKILL.md").read_text(encoding="utf-8")
    assert MANIFEST_SHA256 in skill


def test_the_skill_is_publishable() -> None:
    """The frontmatter ClawHub requires, checked here rather than at publish time.

    ``clawhub skill publish`` reads ``name`` and ``description`` from the YAML
    frontmatter — both mandatory — and ``version`` when it is there. Discovering a
    missing field from a rejected upload is a slow way to learn it.

    The directory check is ours, not ClawHub's: it does not require the two to match,
    but ``clawhub install`` extracts into ``<workdir>/skills/<slug>``, so a name that
    disagrees with the folder means the installed tree does not look like this one.
    """
    skill = (REPO / "skills" / "warrant" / "SKILL.md").read_text(encoding="utf-8")
    assert skill.startswith("---\n"), "no YAML frontmatter"
    frontmatter, body = skill[4:].split("\n---\n", 1)

    fields = {
        line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in frontmatter.splitlines()
        if line and not line.startswith((" ", "-", "#")) and ":" in line
    }
    assert fields["name"] == "warrant", "the skill name must match its directory"
    assert fields["description"], "ClawHub requires a description"
    assert fields["version"].count(".") == 2, (
        "semver required: `clawhub skill publish --version` takes this value"
    )

    # The generated block must have been substituted: publishing the template
    # would ship a skill with no tools, and nothing in the file would say so.
    assert "BEGIN GENERATED: tools" in body
    assert "`quote_risk`" in body and "`request_warrant`" in body
    assert "{{MANIFEST_SHA256}}" not in skill, "placeholder left unsubstituted"
