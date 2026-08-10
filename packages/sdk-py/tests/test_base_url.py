"""The Gateway URL is a scheme decision, not just a string.

``urlopen`` dispatches on the scheme, so an unchecked ``base_url`` is a way to
make the client read something that is not a Gateway and report it as one. These
tests pin the boundary at construction, where the value enters.
"""

from __future__ import annotations

import pytest

from warrant_sdk import WarrantClient, WarrantError

# The schemes the standard opener answers that are *not* a Gateway. `file:` is
# the one that reads the disk; the other two are here so a future opener change
# cannot quietly widen the surface without a red test.
NON_HTTP = [
    "file:///etc/passwd",
    "ftp://example.invalid/pub",
    "data:text/plain,hello",
]


@pytest.mark.parametrize("url", NON_HTTP)
def test_a_non_http_gateway_url_is_refused_at_construction(url: str) -> None:
    with pytest.raises(WarrantError) as caught:
        WarrantClient(base_url=url)
    assert caught.value.code == "invalid_base_url"


def test_a_bare_path_is_refused_rather_than_guessed(monkeypatch: pytest.MonkeyPatch) -> None:
    # "localhost:8402" parses as scheme "localhost", not as a host. Guessing
    # http:// here would be a convenience that hides a typo, so it is refused.
    monkeypatch.delenv("WARRANT_BASE_URL", raising=False)
    with pytest.raises(WarrantError):
        WarrantClient(base_url="/warrant")


def test_the_environment_is_checked_too_not_only_the_argument(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The env var is the likelier attack path of the two: it is set by whatever
    # configures the agent runtime, not by the developer writing the call.
    monkeypatch.setenv("WARRANT_BASE_URL", "file:///etc/passwd")
    with pytest.raises(WarrantError) as caught:
        WarrantClient()
    assert caught.value.code == "invalid_base_url"


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://warrant.fyra.fun", "https://warrant.fyra.fun"),
        ("https://warrant.fyra.fun/", "https://warrant.fyra.fun"),
        ("http://127.0.0.1:8402/", "http://127.0.0.1:8402"),
        ("HTTPS://warrant.fyra.fun", "HTTPS://warrant.fyra.fun"),
    ],
)
def test_an_http_url_survives_untouched_apart_from_its_trailing_slash(
    url: str, expected: str
) -> None:
    # The trailing slash goes because `_request` concatenates a path that starts
    # with one; the rest is left exactly as given, uppercase scheme included.
    assert WarrantClient(base_url=url).base_url == expected
