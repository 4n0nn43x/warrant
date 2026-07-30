"""``warrant`` — the command line, and the surface the OpenClaw skill drives.

Three commands, JSON in and JSON out, because the caller is a program:

```bash
warrant tools                                   # the four tool definitions
warrant call quote_risk '{"actionSpec": {…}}'    # run one
warrant call request_warrant @request.json       # arguments from a file, or - for stdin
```

Exit codes carry the outcome, so a shell or an agent runtime can branch without
parsing:

* ``0`` — done, result on stdout;
* ``1`` — Warrant error, ``{"error": {…}}`` on stdout with ``hint`` and ``docs``;
* ``2`` — payment required, ``{"paymentRequired": {…}}`` on stdout. Not a failure:
  step 2 of the x402 protocol. A distinct code because "the bond costs 5 USDC,
  decide" and "your calldata is malformed" call for different reactions.

The result goes to **stdout** in every case, including errors. A caller that has to
read stderr to learn why a call failed will eventually read only stdout and
conclude the call succeeded.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Sequence

from ._generated import MANIFEST_SHA256, MANIFEST_VERSION
from .client import WarrantClient
from .errors import WarrantError
from .tools import WARRANT_TOOLS, WARRANT_TOOL_NAMES

__all__ = ["main"]

USAGE = """warrant — bonded execution for onchain agents

  warrant tools [--digest]        print the four tool definitions as JSON
  warrant call <tool> <args>      run a tool; <args> is JSON, @file, or - for stdin
  warrant --version

Tools: {tools}

Environment:
  WARRANT_BASE_URL      Gateway root (default http://127.0.0.1:8402)
  WARRANT_PRIVATE_KEY   agent key that signs the EIP-3009 bond authorization;
                        only request_warrant needs it

Exit codes: 0 ok, 1 error, 2 payment required.
""".format(tools=", ".join(WARRANT_TOOL_NAMES))


def _out(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, indent=2, default=str)
    sys.stdout.write("\n")


def _read_args(raw: str) -> Any:
    """JSON literal, ``@path`` or ``-`` for stdin.

    The file and stdin forms exist because an ``actionSpec`` carries full calldata:
    on a long approve, the inline form runs into shell quoting long before it runs
    into anything interesting.
    """
    if raw == "-":
        text = sys.stdin.read()
    elif raw.startswith("@"):
        with open(raw[1:], encoding="utf-8") as handle:
            text = handle.read()
    else:
        text = raw
    try:
        return json.loads(text)
    except json.JSONDecodeError as err:
        raise WarrantError(
            "invalid_input",
            f"Arguments are not valid JSON: {err}",
            hint="Pass a JSON object, @path-to-file, or - to read stdin.",
        ) from err


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point. Returns the process exit code rather than calling ``sys.exit``."""
    args = list(sys.argv[1:] if argv is None else argv)

    if not args or args[0] in ("-h", "--help", "help"):
        sys.stdout.write(USAGE)
        return 0

    if args[0] in ("-V", "--version", "version"):
        _out({"manifestVersion": MANIFEST_VERSION, "manifest": MANIFEST_SHA256})
        return 0

    try:
        if args[0] == "tools":
            if "--digest" in args:
                _out({"manifest": MANIFEST_SHA256})
                return 0
            _out(
                {
                    "manifestVersion": MANIFEST_VERSION,
                    "manifest": MANIFEST_SHA256,
                    "tools": [
                        {
                            "name": tool.name,
                            "title": tool.title,
                            "description": tool.description,
                            "paid": tool.paid,
                            "readOnly": tool.read_only,
                            "inputSchema": tool.input_schema,
                        }
                        for tool in WARRANT_TOOLS
                    ],
                }
            )
            return 0

        if args[0] == "call":
            if len(args) < 3:
                raise WarrantError(
                    "invalid_input",
                    "usage: warrant call <tool> <json|@file|->",
                    hint=f"Tools: {', '.join(WARRANT_TOOL_NAMES)}.",
                )
            name, raw = args[1], args[2]
            payload = _read_args(raw)
            client = WarrantClient()
            outcome = client.call(name, payload)
            if outcome.kind == "payment-required":
                _out(
                    {
                        "paymentRequired": outcome.payment_required,
                        "hint": (
                            "Set WARRANT_PRIVATE_KEY and run the same command again to fund "
                            "the bond. The amount is accepts[0].amount, in atomic units of "
                            "accepts[0].asset."
                        ),
                    }
                )
                return 2
            data = outcome.data
            if outcome.settlement is not None and isinstance(data, dict):
                data = {**data, "settlement": outcome.settlement}
            _out(data)
            return 0

        raise WarrantError(
            "invalid_input",
            f"Unknown command: {args[0]}",
            hint="Run `warrant --help`.",
        )

    except WarrantError as err:
        _out(err.to_json())
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
