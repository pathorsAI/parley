#!/usr/bin/env python3
"""Push a version's store listing to App Store Connect and submit it for review.

Everything a submission needs that lives in this repository — the What's New text
in both locales, the 6.9-inch screenshots, which build to ship — is pushed by
this script, so a release stops depending on somebody retyping it into a web form
at midnight. What it deliberately does *not* touch is the state a human should be
looking at while they decide: the description and keywords (unless
`--sync-metadata` says otherwise), the App Privacy label, pricing and
availability, and App Review Information with the reviewer's credentials.

It runs only in CI. The App Store Connect API key exists solely as the
`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_CONTENT` secrets, so there
is no local path — see `.github/workflows/ios-store-submit.yml`, which is a
`workflow_dispatch` for that reason, and `ios/RELEASING.md`.

The steps, in order, each printed as its own `::group::`:

  1. resolve the app by bundle id
  2. find or create the App Store version, and refuse to edit one Apple has
     taken out of our hands
  3. attach the TestFlight build, waiting for it to finish processing
  4. set What's New per locale from ios/AppStore/metadata/*.md
  5. replace the 6.9-inch screenshot set per locale from ios/AppStore/screenshots/
  6. declare export compliance on the build
  7. create a review submission and submit it — skipped by `--dry-run`

`--dry-run` is the workflow's default and stops before step 7 only. Everything
before it is idempotent: re-running re-attaches the same build, overwrites the
same text, and replaces the screenshot set with an identical one. Step 7 is the
one door that does not open twice, which is why it is the one step a dry run
leaves shut.

Auth is the same ES256 JWT dance as `asc_signing.py`, with one addition: this
script can run for half an hour while screenshots upload, and Apple rejects a
token whose lifetime exceeds 20 minutes, so the token is reissued in flight
rather than minted once at the top.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import textwrap
import time
from pathlib import Path

import jwt
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://api.appstoreconnect.apple.com/v1"
APP_BUNDLE = "com.pathors.parley.ios"
PLATFORM = "IOS"

# The App Store's two localizations, in the order they are processed. These are
# also the metadata filenames and the screenshot directory names, which is not a
# coincidence: `ios/AppStore/` is named after what Connect calls these locales so
# nothing has to translate between the two.
LOCALES = ("en-US", "zh-Hant")

# 1320×2868 is the 6.9-inch iPhone slot, and `APP_IPHONE_67` is what the API
# still calls it: Apple renamed the slot in the Connect UI from 6.7-inch to
# 6.9-inch without renaming the enum, and it accepts both sizes. There is no
# `APP_IPHONE_69`.
SCREENSHOT_DISPLAY_TYPE = "APP_IPHONE_67"

# States in which Apple still lets us edit a version. The first three are the
# ones a release actually meets — a fresh version, one we withdrew ourselves, one
# App Review turned down. `METADATA_REJECTED` and `INVALID_BINARY` are here
# because they are editable too, and stopping with "a human must fix this" when
# the fix is exactly what this script does would be a lie.
#
# Everything else — WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE,
# READY_FOR_SALE, PROCESSING_FOR_APP_STORE … — is Apple's to change, and a PATCH
# against one fails with an error that does not say why.
EDITABLE_STATES = {
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
}

# Apple's limit on the What's New field. Hitting it is a rejection at PATCH time
# with a message about `whatsNew`, which is clear enough, but saying it here names
# the file the text came from.
WHATS_NEW_LIMIT = 4000

BUILD_POLL_SECONDS = 60
BUILD_POLL_ATTEMPTS = 30  # 30 minutes
ASSET_POLL_SECONDS = 5
ASSET_POLL_ATTEMPTS = 60  # 5 minutes per screenshot


# --------------------------------------------------------------------------
# failure


class Stop(SystemExit):
    """A condition only a human can clear. The message says what, and where."""


class ApiError(SystemExit):
    """An App Store Connect response we cannot proceed from.

    Prints the body verbatim. Apple's `errors[]` carries the useful sentence
    about half the time; the other half it is an `id` and a status, and the raw
    body is the only thing that distinguishes "your JWT expired" from "this
    version is not editable".
    """

    def __init__(self, method: str, url: str, response: requests.Response) -> None:
        lines = [f"{method} {url} → {response.status_code}"]
        try:
            for error in response.json().get("errors", []):
                lines.append(
                    f"  [{error.get('status')} {error.get('code')}] {error.get('title')}"
                )
                if error.get("detail"):
                    lines.append(f"      {error['detail']}")
                if error.get("source"):
                    lines.append(f"      source: {error['source']}")
        except ValueError:
            pass
        lines.append("  response body:")
        lines.append(textwrap.indent(response.text[:4000] or "(empty)", "    "))
        super().__init__("\n".join(lines))


# --------------------------------------------------------------------------
# App Store Connect client


class Connect:
    """App Store Connect over HTTPS: JWT auth, retries, and readable errors."""

    LIFETIME = 20 * 60
    REISSUE_AFTER = 15 * 60

    def __init__(self) -> None:
        for name in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_CONTENT"):
            if not os.environ.get(name, "").strip():
                raise Stop(
                    f"{name} is empty. This script needs the App Store Connect "
                    "API key, which exists only as a GitHub secret — see "
                    "ios/RELEASING.md."
                )
        self.key_id = os.environ["ASC_KEY_ID"].strip()
        self.issuer_id = os.environ["ASC_ISSUER_ID"].strip()
        self.key = os.environ["ASC_KEY_CONTENT"]
        self._token = ""
        self._issued = 0.0

        self.session = requests.Session()
        # Retries on 5xx for everything except POST. A POST here creates a review
        # submission or a screenshot reservation, and Apple has answered a
        # perfectly good POST with a bare 500 before (see asc_signing.py) — a
        # retry that succeeds on the second attempt after the first one also
        # landed leaves two of whatever it made, and for /reviewSubmissions the
        # second one blocks the release.
        retry = Retry(
            total=4,
            backoff_factor=2,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET", "PUT", "PATCH", "DELETE", "HEAD"}),
            respect_retry_after_header=True,
            raise_on_status=False,
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def token(self) -> str:
        """A valid bearer token, reissued before Apple would refuse it.

        A run that uploads twelve screenshots outlives one token, and an expired
        one comes back as a 401 halfway through a locale — which reads like a key
        problem rather than a clock one.
        """
        if not self._token or time.time() - self._issued > self.REISSUE_AFTER:
            now = int(time.time())
            self._token = jwt.encode(
                {
                    "iss": self.issuer_id,
                    "iat": now,
                    "exp": now + self.LIFETIME,
                    "aud": "appstoreconnect-v1",
                },
                self.key,
                algorithm="ES256",
                headers={"kid": self.key_id, "typ": "JWT"},
            )
            self._issued = now
        return self._token

    def api(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        *,
        params: dict | None = None,
    ) -> dict:
        url = path if path.startswith("http") else BASE + path
        response = self.session.request(
            method,
            url,
            headers={
                "Authorization": f"Bearer {self.token()}",
                "Content-Type": "application/json",
            },
            json=payload,
            params=params,
            timeout=120,
        )
        if response.status_code >= 400:
            raise ApiError(method, url, response)
        return response.json() if response.content else {}

    def upload(self, operation: dict, blob: bytes) -> None:
        """Run one of an asset reservation's `uploadOperations`.

        The URL is a pre-signed one on Apple's storage, not the API, so it takes
        exactly the headers the reservation handed us and no Authorization header
        — adding one gets a 403 from a service that has never heard of our key.
        """
        headers = {h["name"]: h["value"] for h in operation.get("requestHeaders", [])}
        offset = operation.get("offset", 0)
        length = operation.get("length", len(blob))
        response = self.session.request(
            operation.get("method", "PUT"),
            operation["url"],
            headers=headers,
            data=blob[offset : offset + length],
            timeout=600,
        )
        if response.status_code >= 400:
            raise ApiError(operation.get("method", "PUT"), operation["url"], response)


# --------------------------------------------------------------------------
# reading the repository's metadata


HEADING = re.compile(r"^##[ \t]+What's New[ \t]*[—–-][ \t]*(.+?)[ \t]*$")

# A bullet or a numbered item starts a line of its own. Without this, collapsing a
# hard-wrapped list produces one paragraph with the bullets buried inside it.
BULLET = re.compile(r"^[ \t]*(?:[-*•+]|\d+[.)])[ \t]+")

# CJK ideographs, kana, and the full-width punctuation that goes with them.
# Chinese does not separate words with spaces, so joining two hard-wrapped
# Chinese lines with one inserts a space into the middle of a sentence.
CJK = re.compile(
    r"[⺀-〿぀-鿿豈-﫿︰-﹏＀-￯]"
)


def heading_names_version(tail: str, version: str) -> bool:
    """Does `## What's New — {tail}` name exactly `version`?

    `startswith` alone would read the 1.12 section when asked for 1.1. A version
    may still carry a parenthetical — the 1.0 sections are marked superseded in
    the heading itself — so what follows the number has to be something that
    cannot be part of a version, rather than nothing at all.
    """
    if tail == version:
        return True
    if not tail.startswith(version):
        return False
    following = tail[len(version)]
    return not (following.isdigit() or following in "._-")


def join_lines(first: str, second: str) -> str:
    """Join two hard-wrapped lines of one paragraph, the way its script wants."""
    if CJK.match(first[-1]) or CJK.match(second[0]):
        return first + second
    return f"{first} {second}"


def collapse(body: str) -> str:
    """Undo Markdown's hard wrapping, keeping the blank lines between paragraphs.

    The metadata files are wrapped at 80 columns so they read as prose in a diff.
    App Store Connect wants the opposite: one line per paragraph, because it
    renders the field's own line breaks literally and a file wrapped for review
    would arrive on the product page wrapped for an 80-column terminal.
    """
    out: list[str] = []
    current = ""
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            if current:
                out.append(current)
                current = ""
            if out and out[-1] != "":
                out.append("")
            continue
        if BULLET.match(raw):
            if current:
                out.append(current)
            current = line
        elif current:
            current = join_lines(current, line)
        else:
            current = line
    if current:
        out.append(current)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)


def section(markdown: str, title_matches) -> str | None:
    """The body of the first `## ` section whose heading satisfies `title_matches`."""
    lines = markdown.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("## ") or not title_matches(line):
            continue
        body: list[str] = []
        for following in lines[index + 1 :]:
            if following.startswith("## ") or following.startswith("# "):
                break
            body.append(following)
        return "\n".join(body)
    return None


def whats_new(markdown: str, version: str) -> str | None:
    """The release notes for `version`, collapsed into Connect's shape."""

    def matches(line: str) -> bool:
        found = HEADING.match(line)
        return bool(found and heading_names_version(found.group(1), version))

    body = section(markdown, matches)
    return None if body is None else collapse(body)


def read_whats_new(metadata_dir: Path, locale: str, version: str) -> str:
    path = metadata_dir / f"{locale}.md"
    if not path.exists():
        raise Stop(f"{path} does not exist — there is no {locale} copy to submit.")
    text = whats_new(path.read_text(encoding="utf-8"), version)
    if not text:
        raise Stop(
            f"{path} has no `## What's New — {version}` section.\n"
            "Write the release notes for this version in both metadata files "
            "before submitting; a version must not go to review carrying the "
            "previous release's notes."
        )
    if len(text) > WHATS_NEW_LIMIT:
        raise Stop(
            f"the {locale} What's New for {version} is {len(text)} characters; "
            f"Apple's limit is {WHATS_NEW_LIMIT}. Shorten it in {path}."
        )
    return text


# Field labels in the metadata tables, minus their `(≤ n)` parentheticals, mapped
# to the appStoreVersionLocalization attribute they set. Only what
# `--sync-metadata` is allowed to overwrite: Name and Subtitle belong to
# appInfoLocalizations rather than to a version, and Copyright is the app's.
TABLE_FIELDS = {
    "promotional text": "promotionalText",
    "keywords": "keywords",
    "support url": "supportUrl",
    "marketing url": "marketingUrl",
}

TABLE_ROW = re.compile(r"^\|\s*(?P<label>[^|]+?)\s*\|\s*(?P<value>[^|]+?)\s*\|\s*$")


def listing_metadata(markdown: str) -> dict[str, str]:
    """The description and table fields `--sync-metadata` pushes."""
    fields: dict[str, str] = {}
    for line in markdown.splitlines():
        row = TABLE_ROW.match(line)
        if not row:
            continue
        label = re.sub(r"\s*\(.*\)\s*$", "", row.group("label")).strip().lower()
        if label in TABLE_FIELDS:
            fields[TABLE_FIELDS[label]] = row.group("value").strip()
    description = section(markdown, lambda line: line.startswith("## Description"))
    if description:
        fields["description"] = collapse(description)
    return fields


def screenshots_for(directory: Path) -> list[Path]:
    """A locale's PNGs, in the order they should appear in Connect.

    Sorted by the digit groups in the name rather than by raw string order, so a
    set that ever grows past nine frames does not put 10 between 1 and 2. The
    names are zero-padded today and both orders agree; this is the one that keeps
    agreeing.
    """

    def key(path: Path) -> list:
        return [
            int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", path.name)
        ]

    return sorted(
        (
            path
            for path in directory.iterdir()
            if path.suffix.lower() == ".png" and not path.name.startswith(".")
        ),
        key=key,
    )


# --------------------------------------------------------------------------
# steps


def group(title: str) -> None:
    print(f"::group::{title}", flush=True)


def endgroup() -> None:
    print("::endgroup::", flush=True)


def state_of(version: dict) -> str:
    """A version's review state.

    `appStoreState` is the field this has always been read from, and Apple has
    since introduced `appVersionState` alongside it, deprecating the old name
    without removing it. Prefer the new one and fall back, so this keeps working
    on both sides of the day the old field goes away.
    """
    attributes = version.get("attributes", {})
    return attributes.get("appVersionState") or attributes.get("appStoreState") or "?"


def resolve_app(connect: Connect) -> dict:
    apps = connect.api("GET", "/apps", params={"filter[bundleId]": APP_BUNDLE})["data"]
    # filter[bundleId] is not an exact match — the same trap asc_signing.py hit
    # with filter[identifier], where asking for the app also returned the
    # keyboard. Pick the exact one rather than the first one.
    exact = [a for a in apps if a["attributes"].get("bundleId") == APP_BUNDLE]
    if not exact:
        returned = (
            ", ".join(a["attributes"].get("bundleId", "?") for a in apps) or "(nothing)"
        )
        raise Stop(
            f"no app with bundle id {APP_BUNDLE} is visible to this API key. "
            f"It returned: {returned}"
        )
    app = exact[0]
    print(f"  {app['attributes'].get('name')}  id {app['id']}  {APP_BUNDLE}")
    print(f"  primary locale: {app['attributes'].get('primaryLocale')}")
    return app


def resolve_version(
    connect: Connect, app_id: str, version_string: str, release_type: str
) -> dict:
    """The App Store version to submit — found if it exists, created if not."""
    existing = connect.api(
        "GET",
        f"/apps/{app_id}/appStoreVersions",
        params={
            "filter[versionString]": version_string,
            "filter[platform]": PLATFORM,
        },
    )["data"]

    if existing:
        version = existing[0]
        state = state_of(version)
        print(f"  {version_string} already exists: {version['id']}  state {state}")
        if state not in EDITABLE_STATES:
            raise Stop(
                f"version {version_string} is in state {state}, which App Store "
                "Connect does not let anything edit.\n"
                "  WAITING_FOR_REVIEW / IN_REVIEW: cancel the review submission "
                "in Connect first, or wait for it to come back.\n"
                "  READY_FOR_SALE / PENDING_DEVELOPER_RELEASE: this version has "
                "already shipped — submit the next one instead.\n"
                f"  editable states are {', '.join(sorted(EDITABLE_STATES))}."
            )
        if version["attributes"].get("releaseType") != release_type:
            print(
                f"  releaseType {version['attributes'].get('releaseType')} "
                f"→ {release_type}"
            )
            version = connect.api(
                "PATCH",
                f"/appStoreVersions/{version['id']}",
                {
                    "data": {
                        "type": "appStoreVersions",
                        "id": version["id"],
                        "attributes": {"releaseType": release_type},
                    }
                },
            )["data"]
        return version

    print(f"  no {version_string} yet — creating it, releaseType {release_type}")
    created = connect.api(
        "POST",
        "/appStoreVersions",
        {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "platform": PLATFORM,
                    "versionString": version_string,
                    "releaseType": release_type,
                },
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
            }
        },
    )["data"]
    print(f"  created {created['id']}  state {state_of(created)}")
    return created


def resolve_build(
    connect: Connect, app_id: str, version_string: str, build_number: str
) -> dict:
    """The TestFlight build to ship, once Apple has finished processing it."""
    found = connect.api(
        "GET",
        "/builds",
        params={
            "filter[app]": app_id,
            "filter[version]": build_number,
            "filter[preReleaseVersion.version]": version_string,
        },
    )["data"]
    if not found:
        # Say whether the build is missing or merely attached to a different
        # marketing version: "build 23 of 1.12 does not exist" and "build 23
        # exists but belongs to 1.11" need completely different fixes, and the
        # filtered query above cannot tell them apart.
        loose = connect.api(
            "GET",
            "/builds",
            params={
                "filter[app]": app_id,
                "filter[version]": build_number,
                "include": "preReleaseVersion",
            },
        )
        if loose["data"]:
            others = ", ".join(
                included["attributes"].get("version", "?")
                for included in loose.get("included", [])
                if included["type"] == "preReleaseVersions"
            )
            raise Stop(
                f"build {build_number} exists, but under marketing version "
                f"{others or '(unknown)'} rather than {version_string}. Either "
                "submit that version or upload a build of this one."
            )
        raise Stop(
            f"App Store Connect has no build {build_number} for {version_string}.\n"
            f"Tag `ios-v{version_string}` (or dispatch iOS Release with "
            f"build_number={build_number}) and wait for the upload to process."
        )

    build = found[0]
    for attempt in range(1, BUILD_POLL_ATTEMPTS + 1):
        state = build["attributes"].get("processingState")
        print(f"  build {build_number} ({build['id']}) processingState {state}")
        if state == "VALID":
            return build
        if state != "PROCESSING":
            raise Stop(
                f"build {build_number} is {state}, which can never be attached to "
                "a version. Upload a new build; Apple mails the reason to the "
                "account holder."
            )
        if attempt == BUILD_POLL_ATTEMPTS:
            break
        print(
            f"  still processing — waiting {BUILD_POLL_SECONDS}s "
            f"({attempt}/{BUILD_POLL_ATTEMPTS})"
        )
        time.sleep(BUILD_POLL_SECONDS)
        build = connect.api("GET", f"/builds/{build['id']}")["data"]

    raise Stop(
        f"build {build_number} was still PROCESSING after "
        f"{BUILD_POLL_ATTEMPTS * BUILD_POLL_SECONDS // 60} minutes. Processing "
        "occasionally takes hours; re-run this workflow once TestFlight shows the "
        "build as ready."
    )


def attach_build(connect: Connect, version_id: str, build_id: str) -> None:
    connect.api(
        "PATCH",
        f"/appStoreVersions/{version_id}/relationships/build",
        {"data": {"type": "builds", "id": build_id}},
    )
    print(f"  build {build_id} attached to version {version_id}")


def localizations(connect: Connect, version_id: str) -> dict[str, dict]:
    # No `limit`: some relationship endpoints reject it outright (asc_signing.py
    # found that out on bundleIdCapabilities), and Apple's default page of 50 is
    # far more than a two-locale app can fill.
    data = connect.api(
        "GET", f"/appStoreVersions/{version_id}/appStoreVersionLocalizations"
    )["data"]
    return {item["attributes"]["locale"]: item for item in data}


def set_localization(
    connect: Connect,
    version_id: str,
    existing: dict | None,
    locale: str,
    attributes: dict,
) -> dict:
    if existing:
        return connect.api(
            "PATCH",
            f"/appStoreVersionLocalizations/{existing['id']}",
            {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": existing["id"],
                    "attributes": attributes,
                }
            },
        )["data"]

    # Only reached for a locale the version does not carry yet, which for this app
    # means somebody removed one: both have existed since 1.1. Apple wants a
    # description on a localization it is creating from nothing, so a bare
    # whatsNew can be rejected here — say so before the API does, because its own
    # message does not mention that this script has a flag for it.
    print(
        f"  {locale} has no localization on this version — creating it. If Apple "
        "rejects that for a missing description, add the locale once in App Store "
        "Connect, or re-run with --sync-metadata."
    )
    return connect.api(
        "POST",
        "/appStoreVersionLocalizations",
        {
            "data": {
                "type": "appStoreVersionLocalizations",
                "attributes": {"locale": locale, **attributes},
                "relationships": {
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version_id}
                    }
                },
            }
        },
    )["data"]


def replace_screenshot_set(
    connect: Connect, localization_id: str, locale: str, files: list[Path]
) -> int:
    """Upload a locale's 6.9-inch set, replacing whatever is there.

    Replacing rather than adding: a screenshot cannot be swapped in place, so an
    incremental update would leave the previous release's frames interleaved with
    this one's in an order nobody chose.
    """
    sets = connect.api(
        "GET", f"/appStoreVersionLocalizations/{localization_id}/appScreenshotSets"
    )["data"]
    for existing in sets:
        if (
            existing["attributes"].get("screenshotDisplayType")
            == SCREENSHOT_DISPLAY_TYPE
        ):
            print(
                f"  deleting the existing {SCREENSHOT_DISPLAY_TYPE} set "
                f"{existing['id']}"
            )
            connect.api("DELETE", f"/appScreenshotSets/{existing['id']}")

    created = connect.api(
        "POST",
        "/appScreenshotSets",
        {
            "data": {
                "type": "appScreenshotSets",
                "attributes": {"screenshotDisplayType": SCREENSHOT_DISPLAY_TYPE},
                "relationships": {
                    "appStoreVersionLocalization": {
                        "data": {
                            "type": "appStoreVersionLocalizations",
                            "id": localization_id,
                        }
                    }
                },
            }
        },
    )["data"]
    print(f"  {locale}: new {SCREENSHOT_DISPLAY_TYPE} set {created['id']}")

    for path in files:
        upload_screenshot(connect, created["id"], path)
    return len(files)


def upload_screenshot(connect: Connect, set_id: str, path: Path) -> None:
    """Reserve, upload, commit, and wait for one screenshot.

    Three calls and a wait, because Apple's asset flow is a reservation rather
    than a POST of the bytes: the reservation says where the parts go, the PUTs
    put them there, and the commit gives Apple the checksum to verify them
    against. A screenshot that uploads and never reaches COMPLETE shows up in
    Connect as an empty frame that blocks submission without saying so.
    """
    blob = path.read_bytes()
    reservation = connect.api(
        "POST",
        "/appScreenshots",
        {
            "data": {
                "type": "appScreenshots",
                "attributes": {"fileName": path.name, "fileSize": len(blob)},
                "relationships": {
                    "appScreenshotSet": {
                        "data": {"type": "appScreenshotSets", "id": set_id}
                    }
                },
            }
        },
    )["data"]

    operations = reservation["attributes"].get("uploadOperations") or []
    if not operations:
        raise Stop(
            f"the reservation for {path.name} came back with no uploadOperations, "
            "so there is nowhere to put the bytes. Nothing was uploaded."
        )
    for operation in operations:
        connect.upload(operation, blob)

    committed = connect.api(
        "PATCH",
        f"/appScreenshots/{reservation['id']}",
        {
            "data": {
                "type": "appScreenshots",
                "id": reservation["id"],
                "attributes": {
                    "uploaded": True,
                    "sourceFileChecksum": hashlib.md5(blob).hexdigest(),
                },
            }
        },
    )["data"]

    delivery = committed["attributes"].get("assetDeliveryState") or {}
    for _ in range(ASSET_POLL_ATTEMPTS):
        state = delivery.get("state")
        if state == "COMPLETE":
            print(f"    {path.name}  {len(blob):,} bytes  COMPLETE")
            return
        if state == "FAILED":
            raise Stop(
                f"{path.name} failed Apple's checks: {delivery.get('errors')}\n"
                "A 1320×2868 PNG with no alpha channel is what this slot takes; "
                "regenerate with ios/AppStore/capture-screenshots.sh."
            )
        time.sleep(ASSET_POLL_SECONDS)
        delivery = (
            connect.api("GET", f"/appScreenshots/{reservation['id']}")["data"][
                "attributes"
            ].get("assetDeliveryState")
            or {}
        )

    raise Stop(
        f"{path.name} was still {delivery.get('state')} after "
        f"{ASSET_POLL_ATTEMPTS * ASSET_POLL_SECONDS}s. Check the screenshot set in "
        "App Store Connect before re-running."
    )


def declare_export_compliance(connect: Connect, build: dict, version: dict) -> str:
    """Answer the encryption question on the build, if Apple is still asking.

    Parley talks to its own relay over HTTPS and ships no cryptography of its own,
    which is the `ITSAppUsesNonExemptEncryption = false` case. Left unanswered,
    this is one of the things that silently holds a submission: Connect shows the
    version as ready and App Review never receives it.
    """
    attributes = build["attributes"]
    if attributes.get("usesNonExemptEncryption") is None:
        connect.api(
            "PATCH",
            f"/builds/{build['id']}",
            {
                "data": {
                    "type": "builds",
                    "id": build["id"],
                    "attributes": {"usesNonExemptEncryption": False},
                }
            },
        )
        print("  build usesNonExemptEncryption: unanswered → false (HTTPS is exempt)")
        answer = "set to false"
    else:
        print(
            "  build usesNonExemptEncryption is already "
            f"{attributes['usesNonExemptEncryption']} — left alone"
        )
        answer = f"already {attributes['usesNonExemptEncryption']}"

    # Read-only. The IDFA declaration has moved into the App Privacy
    # questionnaire, which this script does not touch, so the most useful thing it
    # can do is say what Connect currently thinks.
    print(f"  version usesIdfa: {version['attributes'].get('usesIdfa')}")
    return answer


def submit_for_review(connect: Connect, app_id: str, version_id: str) -> str:
    """Create a review submission holding this version, and send it."""
    # Filtered server-side rather than by scanning the list: Connect allows only
    # one open submission per platform at a time, so an open one we failed to
    # notice would turn the POST below into a rejection about a submission the log
    # never mentioned. Asking for exactly the two open states also means the
    # answer cannot be hiding on a second page of old submissions.
    open_submissions = connect.api(
        "GET",
        f"/apps/{app_id}/reviewSubmissions",
        params={
            "filter[platform]": PLATFORM,
            "filter[state]": "READY_FOR_REVIEW,UNRESOLVED_ISSUES",
        },
    )["data"]
    if open_submissions:
        submission = open_submissions[0]
        print(
            f"  reusing the open review submission {submission['id']} "
            f"({submission['attributes'].get('state')})"
        )
    else:
        submission = connect.api(
            "POST",
            "/reviewSubmissions",
            {
                "data": {
                    "type": "reviewSubmissions",
                    "attributes": {"platform": PLATFORM},
                    "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
                }
            },
        )["data"]
        print(f"  created review submission {submission['id']}")

    items = connect.api("GET", f"/reviewSubmissions/{submission['id']}/items")["data"]
    already_there = any(
        (
            (item.get("relationships", {}).get("appStoreVersion") or {}).get("data")
            or {}
        ).get("id")
        == version_id
        for item in items
    )
    if already_there:
        print("  the version is already an item on this submission")
    else:
        connect.api(
            "POST",
            "/reviewSubmissionItems",
            {
                "data": {
                    "type": "reviewSubmissionItems",
                    "relationships": {
                        "reviewSubmission": {
                            "data": {
                                "type": "reviewSubmissions",
                                "id": submission["id"],
                            }
                        },
                        "appStoreVersion": {
                            "data": {"type": "appStoreVersions", "id": version_id}
                        },
                    },
                }
            },
        )
        print(f"  added version {version_id} to the submission")

    submitted = connect.api(
        "PATCH",
        f"/reviewSubmissions/{submission['id']}",
        {
            "data": {
                "type": "reviewSubmissions",
                "id": submission["id"],
                "attributes": {"submitted": True},
            }
        },
    )["data"]
    state = submitted["attributes"].get("state", "?")
    print(f"  submission {submitted['id']} state {state}")
    return state


# --------------------------------------------------------------------------
# main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", required=True, help="marketing version, e.g. 1.12")
    parser.add_argument("--build", required=True, help="CFBundleVersion, e.g. 23")
    parser.add_argument(
        "--release-type",
        default="AFTER_APPROVAL",
        choices=("AFTER_APPROVAL", "MANUAL"),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="do everything except create and send the review submission",
    )
    parser.add_argument(
        "--sync-metadata",
        action="store_true",
        help=(
            "also overwrite description, keywords, promotional text and the URLs "
            "from the metadata files (off by default: those are reviewed in "
            "Connect, not pushed blind)"
        ),
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args(argv)

    metadata_dir = args.repo_root / "ios" / "AppStore" / "metadata"
    screenshot_root = args.repo_root / "ios" / "AppStore" / "screenshots"

    print(f"Parley iOS — submitting {args.version} (build {args.build})")
    print(f"  release type : {args.release_type}")
    print(f"  sync metadata: {args.sync_metadata}")
    if args.dry_run:
        print(
            "  DRY RUN      : yes — the listing will be updated and the build "
            "attached, but\n"
            "                 no review submission will be created or sent."
        )
    else:
        print(
            f"  DRY RUN      : no — this run will submit {args.version} to "
            "App Review."
        )
    print()

    # Read this repository's side of the submission before touching Connect: a
    # missing What's New section should cost nothing, and discovering it after the
    # build is attached leaves the release half-applied.
    notes = {
        locale: read_whats_new(metadata_dir, locale, args.version) for locale in LOCALES
    }

    connect = Connect()
    summary: dict[str, object] = {}

    group("1. Resolve the app")
    app = resolve_app(connect)
    endgroup()

    group(f"2. App Store version {args.version}")
    version = resolve_version(connect, app["id"], args.version, args.release_type)
    summary["version id"] = f"{version['id']} ({state_of(version)})"
    endgroup()

    group(f"3. Attach build {args.build}")
    build = resolve_build(connect, app["id"], args.version, args.build)
    attach_build(connect, version["id"], build["id"])
    summary["build id"] = f"{build['id']} (CFBundleVersion {args.build})"
    endgroup()

    group("4. What's New, per locale")
    version_localizations = localizations(connect, version["id"])
    updated: list[str] = []
    for locale in LOCALES:
        attributes: dict[str, str] = {"whatsNew": notes[locale]}
        if args.sync_metadata:
            listing = listing_metadata(
                (metadata_dir / f"{locale}.md").read_text(encoding="utf-8")
            )
            attributes.update(listing)
            print(f"  {locale}: also syncing {', '.join(sorted(listing))}")
        version_localizations[locale] = set_localization(
            connect, version["id"], version_localizations.get(locale), locale, attributes
        )
        first_line = notes[locale].splitlines()[0]
        print(f"  {locale}: whatsNew {len(notes[locale])} chars — {first_line[:60]}…")
        updated.append(locale)
    summary["localizations updated"] = ", ".join(updated)
    endgroup()

    group("5. Screenshots (6.9-inch)")
    uploaded: dict[str, str] = {}
    for locale in LOCALES:
        directory = screenshot_root / locale
        if not directory.is_dir():
            print(
                f"  {locale}: {directory} is missing — leaving the set in Connect "
                "alone"
            )
            uploaded[locale] = "skipped (no directory)"
            continue
        files = screenshots_for(directory)
        if not files:
            print(f"  {locale}: {directory} holds no PNGs — leaving Connect alone")
            uploaded[locale] = "skipped (no PNGs)"
            continue
        print(f"  {locale}: {', '.join(path.name for path in files)}")
        uploaded[locale] = str(
            replace_screenshot_set(
                connect, version_localizations[locale]["id"], locale, files
            )
        )
    summary["screenshots"] = ", ".join(f"{k}: {v}" for k, v in uploaded.items())
    endgroup()

    group("6. Export compliance")
    summary["export compliance"] = declare_export_compliance(connect, build, version)
    endgroup()

    group("7. Submit for review")
    if args.dry_run:
        print(
            "  skipped: --dry-run. Everything above is in App Store Connect; "
            "nothing has been sent to App Review."
        )
        summary["submission"] = "not submitted (dry run)"
    else:
        summary["submission"] = submit_for_review(connect, app["id"], version["id"])
        final = connect.api("GET", f"/appStoreVersions/{version['id']}")["data"]
        print(f"  version state is now {state_of(final)}")
        summary["version id"] = f"{version['id']} ({state_of(final)})"
    endgroup()

    print()
    print(f"Summary — {args.version} (build {args.build})")
    width = max(len(key) for key in summary)
    for key, value in summary.items():
        print(f"  {key.ljust(width)}  {value}")
    print()
    print("Still manual in App Store Connect: description and keywords (unless")
    print("--sync-metadata), the App Privacy label, pricing and availability, and")
    print("App Review Information including the reviewer account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
