# OpenClaw skills

One skill: [`warrant/`](warrant) — bonded execution for onchain actions, published
on [ClawHub](https://docs.openclaw.ai/clawhub).

## Install it

```bash
npm i -g clawhub          # once
clawhub install @warrant/warrant
```

That drops the skill into `./skills` and records the version in
`.clawhub/lock.json`. OpenClaw picks it up from there; nothing else to wire.

The skill drives the `warrant` CLI from
[`packages/sdk-py`](../packages/sdk-py), so it needs `uvx` (or `pipx`) on the
`PATH` — declared in the frontmatter as `requires.anyBins`, which means OpenClaw
gates the skill off rather than surfacing a tool that cannot run.

## `SKILL.md` is generated — do not edit it

The runbook prose is written by hand in
[`packages/sdk-py/codegen/skill-template.md`](../packages/sdk-py/codegen/skill-template.md).
The tool section between the `BEGIN GENERATED` markers is emitted from the Warrant
single source of truth, so the skill cannot describe a tool the Gateway does not
serve:

```bash
pnpm tsx packages/sdk-py/codegen/emit.ts          # regenerate
pnpm tsx packages/sdk-py/codegen/emit.ts --check  # exits 1 on drift
```

`packages/sdk-py/tests/test_codegen_drift.py` runs the check, and asserts that the
published `SKILL.md` carries the manifest digest it was built from — so a stale
skill is detectable without reading any code.

## Publish a new version

```bash
# bump `version` in codegen/skill-template.md, then regenerate before publishing:
# the digest at the bottom of SKILL.md is what makes a stale skill detectable
pnpm tsx packages/sdk-py/codegen/emit.ts
clawhub login                                              # once
clawhub skill publish skills/warrant --version 0.1.0       # the frontmatter version
```

`--version` is worth passing explicitly. Without it the CLI auto-versions —
`1.0.0` for a first publish, the next patch for a changed one — which would quietly
disagree with the `version` in the frontmatter this repo generates.

Everything on ClawHub is MIT-0 licensed, and the published bundle is a folder whose
only required file is `SKILL.md` — which is why the template stays in `codegen/`
rather than next to the published file. The directory name is not required to match
the frontmatter `name`, but `clawhub install` extracts into
`<workdir>/skills/<slug>`, so keeping the two equal means the installed tree looks
like this one.

Before publishing, `clawhub inspect @warrant/warrant --files` shows what a consumer
would get; ClawHub also runs a security analysis that compares the declared
`requires` against what the skill actually does, so the frontmatter is worth
keeping honest rather than minimal.
