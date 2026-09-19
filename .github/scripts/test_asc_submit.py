#!/usr/bin/env python3
"""Unit tests for asc_submit.py.

Run before the real script in `.github/workflows/ios-store-submit.yml`, not in
`ci.yml`: `ci.yml` is the desktop app's pre-merge gate and ignores `ios/**`
entirely, so a test living there would run on every frontend PR and never on the
one that matters.

    python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v

What is worth testing here is what a dry run cannot tell you. A dry run against
Apple proves the API calls are shaped right; it cannot prove that the What's New
parser picked the 1.1 section instead of the 1.12 one, that ten screenshots would
upload in the order a human numbered them, or that a version already in review is
refused rather than patched. Those three are exactly the failures that arrive as
a wrong product page rather than as an error, so they are tested against fixtures
and a fake client with no network anywhere.

`--rename-editable-version` is here for the opposite reason: a dry run cannot
reach it at all without an App Store Connect that happens to be in the one state
it exists for. Its decisions — rename the single waiting version, refuse to pick
between two, create when there is nothing to rename, and stay out of the way when
it is off — are decided entirely from the version list, so they are decided here
too, against the same fake client.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import asc_submit as submit  # noqa: E402


# A metadata file in the shape ios/AppStore/metadata/en-US.md is really in: a
# field table, hard-wrapped prose, a bullet list, and several sections in a row —
# including one whose heading carries a parenthetical after the version.
EN_FIXTURE = """\
# en-US App Store metadata

| Field | Value |
| --- | --- |
| Name (≤ 30) | Parley: Dictation & Meetings |
| Promotional text (≤ 170) | Voice typing in any app. |
| Keywords (≤ 100 bytes) | voice typing,dictation,meeting |
| Support URL | https://parley.tw/support/ |

## Description (≤ 4,000 chars)

Parley turns your voice into text on your iPhone two ways — and both run on
the same transcription.

## What's New — 1.12

Recordings can be played back on the phone. Meetings recorded here now stay
on the phone, and a recording made elsewhere can be downloaded from its row,
its long-press menu, or the transcript screen.

The app looks different. The page is white, the text is ink, and blue is
reserved for what is happening right now.

## What's New — 1.5

The keyboard grew up in this release:

- New Bopomofo (Zhuyin) keyboard — swipe between the voice, English, and
  Traditional Chinese panes.
- Dictation now lands in your document in one piece when the session ends,
  instead of streaming in word by word.

## What's New — 1.1

Voice typing comes to the phone.

## What's New — 1.0 (superseded, kept for history)

First release of Parley for iPhone.

## Notes on the choices here

- **The name carries two search terms.**
"""

# The Chinese copy wraps too, and joining its lines with a space would put one in
# the middle of a sentence.
ZH_FIXTURE = """\
## What's New — 1.12

錄音可以在手機上回放了。在這支手機錄的會議會留在手機上，其他裝置的錄音則
可以從列表右滑、長按選單或逐字稿頁下載。

App 長得不一樣了。頁面是白的、字是墨色的。

## What's New — 1.7

聽寫現在會幫你把話排好。
"""


class WhatsNewParser(unittest.TestCase):
    def test_collapses_hard_wrapped_paragraphs(self):
        text = submit.whats_new(EN_FIXTURE, "1.12")
        self.assertEqual(
            text,
            "Recordings can be played back on the phone. Meetings recorded here "
            "now stay on the phone, and a recording made elsewhere can be "
            "downloaded from its row, its long-press menu, or the transcript "
            "screen."
            "\n\n"
            "The app looks different. The page is white, the text is ink, and "
            "blue is reserved for what is happening right now.",
        )

    def test_stops_at_the_next_section(self):
        """The 1.12 notes must not swallow the 1.5 heading or its bullets."""
        text = submit.whats_new(EN_FIXTURE, "1.12")
        self.assertNotIn("What's New", text)
        self.assertNotIn("Bopomofo", text)
        self.assertNotIn("keyboard grew up", text)

    def test_a_version_prefix_is_not_a_match(self):
        """Asked for 1.1, do not hand back 1.12."""
        self.assertEqual(submit.whats_new(EN_FIXTURE, "1.1"), "Voice typing comes to the phone.")

    def test_a_parenthetical_after_the_version_still_matches(self):
        self.assertEqual(
            submit.whats_new(EN_FIXTURE, "1.0"), "First release of Parley for iPhone."
        )

    def test_bullets_stay_on_their_own_lines(self):
        text = submit.whats_new(EN_FIXTURE, "1.5")
        self.assertEqual(
            text.splitlines(),
            [
                "The keyboard grew up in this release:",
                "",
                "- New Bopomofo (Zhuyin) keyboard — swipe between the voice, "
                "English, and Traditional Chinese panes.",
                "- Dictation now lands in your document in one piece when the "
                "session ends, instead of streaming in word by word.",
            ],
        )

    def test_chinese_lines_join_without_a_space(self):
        text = submit.whats_new(ZH_FIXTURE, "1.12")
        self.assertIn("其他裝置的錄音則可以從列表右滑", text)
        self.assertNotIn(" 可以從列表", text)
        self.assertEqual(len(text.split("\n\n")), 2)

    def test_a_missing_section_is_not_silently_empty(self):
        self.assertIsNone(submit.whats_new(EN_FIXTURE, "9.9"))

    def test_read_whats_new_names_the_file_and_the_version(self):
        directory = Path(self.enterContext(_temporary_directory()))
        (directory / "en-US.md").write_text(EN_FIXTURE, encoding="utf-8")
        self.assertTrue(submit.read_whats_new(directory, "en-US", "1.12"))
        with self.assertRaises(submit.Stop) as raised:
            submit.read_whats_new(directory, "en-US", "2.0")
        self.assertIn("What's New — 2.0", str(raised.exception))
        self.assertIn("en-US.md", str(raised.exception))

    def test_read_whats_new_rejects_a_field_over_apples_limit(self):
        directory = Path(self.enterContext(_temporary_directory()))
        long_line = "word " * 1000
        (directory / "en-US.md").write_text(
            f"## What's New — 1.12\n\n{long_line}\n", encoding="utf-8"
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.read_whats_new(directory, "en-US", "1.12")
        self.assertIn(str(submit.WHATS_NEW_LIMIT), str(raised.exception))


class ListingMetadata(unittest.TestCase):
    """What `--sync-metadata` would push, and what it must leave alone."""

    def test_reads_the_field_table_and_the_description(self):
        fields = submit.listing_metadata(EN_FIXTURE)
        self.assertEqual(fields["promotionalText"], "Voice typing in any app.")
        self.assertEqual(fields["keywords"], "voice typing,dictation,meeting")
        self.assertEqual(fields["supportUrl"], "https://parley.tw/support/")
        self.assertEqual(
            fields["description"],
            "Parley turns your voice into text on your iPhone two ways — and "
            "both run on the same transcription.",
        )

    def test_leaves_fields_that_do_not_belong_to_a_version(self):
        """Name is an appInfoLocalization attribute; pushing it here would 400."""
        self.assertNotIn("name", submit.listing_metadata(EN_FIXTURE))


class ScreenshotOrdering(unittest.TestCase):
    def test_filename_order(self):
        directory = Path(self.enterContext(_temporary_directory()))
        for name in ("03-library.png", "01-welcome.png", "02-record.png"):
            (directory / name).write_bytes(b"")
        self.assertEqual(
            [path.name for path in submit.screenshots_for(directory)],
            ["01-welcome.png", "02-record.png", "03-library.png"],
        )

    def test_ten_does_not_sort_between_one_and_two(self):
        directory = Path(self.enterContext(_temporary_directory()))
        for name in ("1-a.png", "2-b.png", "10-c.png"):
            (directory / name).write_bytes(b"")
        self.assertEqual(
            [path.name for path in submit.screenshots_for(directory)],
            ["1-a.png", "2-b.png", "10-c.png"],
        )

    def test_only_visible_pngs(self):
        directory = Path(self.enterContext(_temporary_directory()))
        for name in ("01.png", "02.PNG", "README.md", ".DS_Store", "notes.txt"):
            (directory / name).write_bytes(b"")
        self.assertEqual(
            [path.name for path in submit.screenshots_for(directory)],
            ["01.png", "02.PNG"],
        )

    def test_the_repositorys_own_sets_are_in_order(self):
        """The real thing, so a renamed screenshot cannot quietly reorder the set."""
        root = Path(__file__).resolve().parents[2] / "ios" / "AppStore" / "screenshots"
        for locale in submit.LOCALES:
            with self.subTest(locale=locale):
                names = [path.name for path in submit.screenshots_for(root / locale)]
                self.assertEqual(names, sorted(names))
                self.assertTrue(names[0].startswith("01-"), names)


class FakeConnect:
    """An App Store Connect that answers from a script instead of over HTTPS.

    Keyed on (method, path) rather than on call order, because the script's order
    is an implementation detail and a test that pins it fails on every harmless
    reshuffle. A list as the value answers repeated calls in turn, which is how
    "the build is PROCESSING and then VALID" is expressed.
    """

    def __init__(self, responses: dict):
        self.responses = {key: list(value) if isinstance(value, list) else [value]
                          for key, value in responses.items()}
        self.calls: list[SimpleNamespace] = []
        self.uploads: list[tuple[dict, bytes]] = []

    def api(self, method, path, payload=None, *, params=None):
        self.calls.append(
            SimpleNamespace(method=method, path=path, payload=payload, params=params)
        )
        queue = self.responses.get((method, path))
        if not queue:
            raise AssertionError(f"unscripted call: {method} {path} {params or ''}")
        answer = queue[0] if len(queue) == 1 else queue.pop(0)
        # A scripted exception is a call Apple refuses. `BaseException` rather
        # than `Exception` on purpose: ApiError and Stop are both SystemExit,
        # which does not descend from Exception.
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def upload(self, operation, blob):
        self.uploads.append((operation, blob))

    def made(self, method, path) -> bool:
        return any(call.method == method and call.path == path for call in self.calls)


def version_payload(
    identifier: str,
    state: str,
    release_type: str = "AFTER_APPROVAL",
    version_string: str = "1.12",
):
    return {
        "id": identifier,
        "type": "appStoreVersions",
        "attributes": {
            "versionString": version_string,
            "platform": "IOS",
            "appVersionState": state,
            "releaseType": release_type,
        },
    }


def conflict_409(detail: str) -> submit.ApiError:
    """Apple's 409 on POST /appStoreVersions, without a socket.

    ApiError reads exactly three things off a response — the status, the parsed
    `errors[]`, and the raw text — so a stand-in carrying those three is the
    whole of it, and this file keeps the no-network property that lets it run in
    the submit workflow. The `source` pointer is the real one: Apple blames the
    app relationship for a problem that is not there.
    """
    body = {
        "errors": [
            {
                "id": "00000000-0000-0000-0000-000000000000",
                "status": "409",
                "code": "ENTITY_ERROR.RELATIONSHIP.INVALID",
                "title": "The provided entity includes a relationship with an "
                "invalid value",
                "detail": detail,
                "source": {"pointer": "/data/relationships/app"},
            }
        ]
    }
    return submit.ApiError(
        "POST",
        f"{submit.BASE}/appStoreVersions",
        SimpleNamespace(
            status_code=409, json=lambda: body, text=json.dumps(body, indent=2)
        ),
    )


class VersionStateGuard(unittest.TestCase):
    LIST = ("GET", "/apps/APP/appStoreVersions")

    def test_a_version_in_review_stops_the_run(self):
        connect = FakeConnect(
            {self.LIST: {"data": [version_payload("V", "WAITING_FOR_REVIEW")]}}
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.resolve_version(connect, "APP", "1.12", "AFTER_APPROVAL")
        message = str(raised.exception)
        self.assertIn("WAITING_FOR_REVIEW", message)
        self.assertIn("cancel the review submission", message)
        # Nothing may have been written on the way to refusing.
        self.assertEqual([call.method for call in connect.calls], ["GET"])

    def test_a_shipped_version_stops_the_run(self):
        connect = FakeConnect(
            {self.LIST: {"data": [version_payload("V", "READY_FOR_SALE")]}}
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.resolve_version(connect, "APP", "1.12", "AFTER_APPROVAL")
        self.assertIn("already shipped", str(raised.exception))

    def test_an_editable_version_is_reused_rather_than_recreated(self):
        for state in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED"):
            with self.subTest(state=state):
                connect = FakeConnect(
                    {self.LIST: {"data": [version_payload("V", state)]}}
                )
                version = submit.resolve_version(
                    connect, "APP", "1.12", "AFTER_APPROVAL"
                )
                self.assertEqual(version["id"], "V")
                self.assertFalse(connect.made("POST", "/appStoreVersions"))
                self.assertFalse(connect.made("PATCH", "/appStoreVersions/V"))

    def test_the_legacy_state_field_is_still_understood(self):
        """Apple deprecated appStoreState in favour of appVersionState."""
        legacy = {
            "id": "V",
            "attributes": {"appStoreState": "IN_REVIEW", "releaseType": "AFTER_APPROVAL"},
        }
        connect = FakeConnect({self.LIST: {"data": [legacy]}})
        with self.assertRaises(submit.Stop) as raised:
            submit.resolve_version(connect, "APP", "1.12", "AFTER_APPROVAL")
        self.assertIn("IN_REVIEW", str(raised.exception))

    def test_a_missing_version_is_created_with_the_release_type(self):
        connect = FakeConnect(
            {
                self.LIST: {"data": []},
                ("POST", "/appStoreVersions"): {
                    "data": version_payload("NEW", "PREPARE_FOR_SUBMISSION", "MANUAL")
                },
            }
        )
        version = submit.resolve_version(connect, "APP", "1.12", "MANUAL")
        self.assertEqual(version["id"], "NEW")
        posted = connect.calls[-1].payload["data"]
        self.assertEqual(posted["type"], "appStoreVersions")
        self.assertEqual(posted["attributes"]["platform"], "IOS")
        self.assertEqual(posted["attributes"]["versionString"], "1.12")
        self.assertEqual(posted["attributes"]["releaseType"], "MANUAL")
        self.assertEqual(
            posted["relationships"]["app"]["data"], {"type": "apps", "id": "APP"}
        )

    def test_a_differing_release_type_is_patched_onto_the_existing_version(self):
        connect = FakeConnect(
            {
                self.LIST: {
                    "data": [version_payload("V", "PREPARE_FOR_SUBMISSION", "MANUAL")]
                },
                ("PATCH", "/appStoreVersions/V"): {
                    "data": version_payload("V", "PREPARE_FOR_SUBMISSION")
                },
            }
        )
        submit.resolve_version(connect, "APP", "1.12", "AFTER_APPROVAL")
        patched = connect.calls[-1].payload["data"]
        self.assertEqual(patched["attributes"], {"releaseType": "AFTER_APPROVAL"})
        self.assertEqual(patched["id"], "V")


class RenameEditableVersion(unittest.TestCase):
    """`--rename-editable-version`, the one field a human changes in Connect.

    App Store Connect allows one version in an editable state at a time, so 1.15
    could not be created while 1.14 sat in PREPARE_FOR_SUBMISSION, never
    submitted. Renaming 1.14 is the whole fix.

    FakeConnect keys on (method, path) and ignores params, so resolve_version's
    filtered lookup and the unfiltered listing the rename does share one queue:
    the two-element lists below are those two answers, in that order.
    """

    LIST = ("GET", "/apps/APP/appStoreVersions")

    def waiting(self, state="PREPARE_FOR_SUBMISSION", release_type="MANUAL"):
        return version_payload("V14", state, release_type, version_string="1.14")

    def test_the_waiting_version_is_renamed_and_carried_on_with(self):
        connect = FakeConnect(
            {
                self.LIST: [{"data": []}, {"data": [self.waiting()]}],
                ("PATCH", "/appStoreVersions/V14"): {
                    "data": version_payload(
                        "V14", "PREPARE_FOR_SUBMISSION", version_string="1.15"
                    )
                },
            }
        )
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            version = submit.resolve_version(
                connect, "APP", "1.15", "AFTER_APPROVAL", allow_rename=True
            )

        self.assertEqual(version["id"], "V14")
        self.assertEqual(version["attributes"]["versionString"], "1.15")
        self.assertFalse(connect.made("POST", "/appStoreVersions"))

        patched = connect.calls[-1].payload["data"]
        self.assertEqual(patched["id"], "V14")
        # The releaseType rides along: a renamed version is by definition the one
        # this run is submitting, so it should carry the type the run asked for
        # rather than the one the abandoned version happened to have.
        self.assertEqual(
            patched["attributes"],
            {"versionString": "1.15", "releaseType": "AFTER_APPROVAL"},
        )

        # Both strings and the id, because this log line is the only record that
        # a version somebody prepared was repurposed as this release.
        log = printed.getvalue()
        for fragment in ("1.14", "1.15", "V14"):
            self.assertIn(fragment, log)

    def test_two_editable_versions_stop_rather_than_pick_one(self):
        """Connect is not supposed to allow this, and guessing renames the wrong one."""
        connect = FakeConnect(
            {
                self.LIST: [
                    {"data": []},
                    {
                        "data": [
                            self.waiting(),
                            version_payload("V9", "REJECTED", version_string="1.9"),
                        ]
                    },
                ]
            }
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.resolve_version(
                connect, "APP", "1.15", "AFTER_APPROVAL", allow_rename=True
            )
        message = str(raised.exception)
        for fragment in ("1.14", "V14", "PREPARE_FOR_SUBMISSION", "1.9", "V9", "REJECTED"):
            self.assertIn(fragment, message)
        # Two reads and nothing written on the way to refusing.
        self.assertEqual([call.method for call in connect.calls], ["GET", "GET"])

    def test_nothing_editable_falls_through_to_the_create_path(self):
        """The ordinary case: the last version shipped, so creating is correct."""
        connect = FakeConnect(
            {
                self.LIST: [
                    {"data": []},
                    {
                        "data": [
                            version_payload(
                                "OLD", "READY_FOR_SALE", version_string="1.14"
                            )
                        ]
                    },
                ],
                ("POST", "/appStoreVersions"): {
                    "data": version_payload(
                        "NEW", "PREPARE_FOR_SUBMISSION", version_string="1.15"
                    )
                },
            }
        )
        version = submit.resolve_version(
            connect, "APP", "1.15", "AFTER_APPROVAL", allow_rename=True
        )
        self.assertEqual(version["id"], "NEW")
        self.assertFalse(any(call.method == "PATCH" for call in connect.calls))
        self.assertEqual(
            connect.calls[-1].payload["data"]["attributes"]["versionString"], "1.15"
        )

    def test_a_found_version_is_never_renamed(self):
        """Renaming applies only where the version does not exist yet."""
        connect = FakeConnect(
            {
                self.LIST: {
                    "data": [
                        version_payload(
                            "V", "PREPARE_FOR_SUBMISSION", version_string="1.15"
                        )
                    ]
                }
            }
        )
        version = submit.resolve_version(
            connect, "APP", "1.15", "AFTER_APPROVAL", allow_rename=True
        )
        self.assertEqual(version["id"], "V")
        self.assertEqual([call.method for call in connect.calls], ["GET"])

    def test_off_by_default_the_version_list_is_never_even_read(self):
        """With renaming off, step 2 makes exactly the calls it always made."""
        connect = FakeConnect(
            {
                self.LIST: {"data": []},
                ("POST", "/appStoreVersions"): {
                    "data": version_payload(
                        "NEW", "PREPARE_FOR_SUBMISSION", version_string="1.15"
                    )
                },
            }
        )
        version = submit.resolve_version(connect, "APP", "1.15", "AFTER_APPROVAL")
        self.assertEqual(version["id"], "NEW")
        lookups = [call for call in connect.calls if call.path == self.LIST[1]]
        self.assertEqual(len(lookups), 1)
        self.assertEqual(lookups[0].params["filter[versionString]"], "1.15")


class PendingVersionConflict(unittest.TestCase):
    """Apple's 409 on the create path, translated into what is actually wrong."""

    LIST = ("GET", "/apps/APP/appStoreVersions")

    def test_it_names_the_version_in_the_way_and_the_way_out(self):
        connect = FakeConnect(
            {
                self.LIST: [
                    {"data": []},
                    {
                        "data": [
                            version_payload(
                                "V14",
                                "PREPARE_FOR_SUBMISSION",
                                version_string="1.14",
                            )
                        ]
                    },
                ],
                ("POST", "/appStoreVersions"): conflict_409(
                    f"{submit.VERSION_ALREADY_PENDING}."
                ),
            }
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.resolve_version(connect, "APP", "1.15", "AFTER_APPROVAL")
        message = str(raised.exception)
        # What is in the way, and where.
        self.assertIn("1.14", message)
        self.assertIn("V14", message)
        self.assertIn("PREPARE_FOR_SUBMISSION", message)
        # And the input that clears it without opening a browser.
        self.assertIn("--rename-editable-version", message)
        self.assertIn("rename_editable_version=true", message)
        # Apple's own sentence and its misleading pointer survive into the new
        # message, so searching the log for either still lands on this.
        self.assertIn(submit.VERSION_ALREADY_PENDING, message)
        self.assertIn("/data/relationships/app", message)

    def test_any_other_conflict_travels_as_it_always_did(self):
        """Only the one sentence is translated; the rest stay raw for a reason."""
        connect = FakeConnect(
            {
                self.LIST: {"data": []},
                ("POST", "/appStoreVersions"): conflict_409(
                    "The attribute 'versionString' has an invalid value."
                ),
            }
        )
        with self.assertRaises(submit.ApiError) as raised:
            submit.resolve_version(connect, "APP", "1.15", "AFTER_APPROVAL")
        self.assertIn("'versionString' has an invalid value", str(raised.exception))
        # No second look at the version list: there is nothing to explain here.
        self.assertEqual(
            len([call for call in connect.calls if call.path == self.LIST[1]]), 1
        )


class ScreenshotUpload(unittest.TestCase):
    """The reservation → PUT → commit → poll flow, without Apple."""

    def test_reserves_uploads_commits_and_waits(self):
        directory = Path(self.enterContext(_temporary_directory()))
        png = directory / "01-welcome.png"
        png.write_bytes(b"pretend-png-bytes")
        operation = {
            "method": "PUT",
            "url": "https://upload.example/part-1",
            "offset": 0,
            "length": len(b"pretend-png-bytes"),
            "requestHeaders": [{"name": "Content-Type", "value": "image/png"}],
        }
        connect = FakeConnect(
            {
                ("POST", "/appScreenshots"): {
                    "data": {
                        "id": "SHOT",
                        "attributes": {"uploadOperations": [operation]},
                    }
                },
                ("PATCH", "/appScreenshots/SHOT"): {
                    "data": {
                        "attributes": {
                            "assetDeliveryState": {"state": "COMPLETE", "errors": []}
                        }
                    }
                },
            }
        )
        submit.upload_screenshot(connect, "SET", png)

        reserved = connect.calls[0].payload["data"]
        self.assertEqual(reserved["attributes"]["fileName"], "01-welcome.png")
        self.assertEqual(reserved["attributes"]["fileSize"], len(b"pretend-png-bytes"))
        self.assertEqual(
            reserved["relationships"]["appScreenshotSet"]["data"],
            {"type": "appScreenshotSets", "id": "SET"},
        )
        self.assertEqual(connect.uploads, [(operation, b"pretend-png-bytes")])

        committed = connect.calls[-1].payload["data"]["attributes"]
        self.assertIs(committed["uploaded"], True)
        self.assertEqual(
            committed["sourceFileChecksum"],
            hashlib.md5(b"pretend-png-bytes").hexdigest(),
        )

    def test_a_reservation_with_nowhere_to_upload_stops(self):
        directory = Path(self.enterContext(_temporary_directory()))
        png = directory / "01.png"
        png.write_bytes(b"x")
        connect = FakeConnect(
            {
                ("POST", "/appScreenshots"): {
                    "data": {"id": "SHOT", "attributes": {"uploadOperations": []}}
                }
            }
        )
        with self.assertRaises(submit.Stop) as raised:
            submit.upload_screenshot(connect, "SET", png)
        self.assertIn("uploadOperations", str(raised.exception))
        self.assertEqual(connect.uploads, [])

    def test_the_existing_set_is_deleted_before_a_new_one_is_made(self):
        connect = FakeConnect(
            {
                ("GET", "/appStoreVersionLocalizations/LOC/appScreenshotSets"): {
                    "data": [
                        {
                            "id": "OLD",
                            "attributes": {
                                "screenshotDisplayType": submit.SCREENSHOT_DISPLAY_TYPE
                            },
                        },
                        {
                            "id": "IPAD",
                            "attributes": {"screenshotDisplayType": "APP_IPAD_PRO_3GEN_129"},
                        },
                    ]
                },
                ("DELETE", "/appScreenshotSets/OLD"): {},
                ("POST", "/appScreenshotSets"): {"data": {"id": "NEW"}},
            }
        )
        count = submit.replace_screenshot_set(connect, "LOC", "en-US", [])
        self.assertEqual(count, 0)
        self.assertTrue(connect.made("DELETE", "/appScreenshotSets/OLD"))
        # The iPad set is another slot's problem and is left where it is.
        self.assertFalse(connect.made("DELETE", "/appScreenshotSets/IPAD"))
        created = connect.calls[-1].payload["data"]
        self.assertEqual(
            created["attributes"]["screenshotDisplayType"],
            submit.SCREENSHOT_DISPLAY_TYPE,
        )
        self.assertEqual(
            created["relationships"]["appStoreVersionLocalization"]["data"],
            {"type": "appStoreVersionLocalizations", "id": "LOC"},
        )


class ReviewSubmission(unittest.TestCase):
    """The three calls step 7 makes, and the one it must not make twice."""

    OPEN = ("GET", "/apps/APP/reviewSubmissions")

    def test_creates_an_item_and_submits(self):
        connect = FakeConnect(
            {
                self.OPEN: {"data": []},
                ("POST", "/reviewSubmissions"): {"data": {"id": "RS"}},
                ("GET", "/reviewSubmissions/RS/items"): {"data": []},
                ("POST", "/reviewSubmissionItems"): {"data": {"id": "ITEM"}},
                ("PATCH", "/reviewSubmissions/RS"): {
                    "data": {"id": "RS", "attributes": {"state": "WAITING_FOR_REVIEW"}}
                },
            }
        )
        state = submit.submit_for_review(connect, "APP", "V")
        self.assertEqual(state, "WAITING_FOR_REVIEW")

        created = connect.calls[1].payload["data"]
        self.assertEqual(created["attributes"], {"platform": "IOS"})
        self.assertEqual(
            created["relationships"]["app"]["data"], {"type": "apps", "id": "APP"}
        )

        item = connect.calls[3].payload["data"]["relationships"]
        self.assertEqual(
            item["reviewSubmission"]["data"],
            {"type": "reviewSubmissions", "id": "RS"},
        )
        self.assertEqual(
            item["appStoreVersion"]["data"],
            {"type": "appStoreVersions", "id": "V"},
        )

        self.assertEqual(
            connect.calls[-1].payload["data"]["attributes"], {"submitted": True}
        )

    def test_reuses_an_open_submission_rather_than_making_a_second(self):
        """Connect allows one open submission per platform; a second is rejected."""
        connect = FakeConnect(
            {
                self.OPEN: {
                    "data": [{"id": "RS", "attributes": {"state": "READY_FOR_REVIEW"}}]
                },
                ("GET", "/reviewSubmissions/RS/items"): {"data": []},
                ("POST", "/reviewSubmissionItems"): {"data": {"id": "ITEM"}},
                ("PATCH", "/reviewSubmissions/RS"): {
                    "data": {"id": "RS", "attributes": {"state": "WAITING_FOR_REVIEW"}}
                },
            }
        )
        submit.submit_for_review(connect, "APP", "V")
        self.assertFalse(connect.made("POST", "/reviewSubmissions"))

    def test_does_not_add_the_version_twice(self):
        connect = FakeConnect(
            {
                self.OPEN: {
                    "data": [{"id": "RS", "attributes": {"state": "READY_FOR_REVIEW"}}]
                },
                ("GET", "/reviewSubmissions/RS/items"): {
                    "data": [
                        {
                            "id": "ITEM",
                            "relationships": {
                                "appStoreVersion": {
                                    "data": {"type": "appStoreVersions", "id": "V"}
                                }
                            },
                        }
                    ]
                },
                ("PATCH", "/reviewSubmissions/RS"): {
                    "data": {"id": "RS", "attributes": {"state": "WAITING_FOR_REVIEW"}}
                },
            }
        )
        submit.submit_for_review(connect, "APP", "V")
        self.assertFalse(connect.made("POST", "/reviewSubmissionItems"))


class ExportCompliance(unittest.TestCase):
    def test_an_unanswered_build_is_declared_exempt(self):
        connect = FakeConnect({("PATCH", "/builds/B"): {}})
        build = {"id": "B", "attributes": {"usesNonExemptEncryption": None}}
        answer = submit.declare_export_compliance(
            connect, build, {"attributes": {"usesIdfa": False}}
        )
        self.assertIn("false", answer)
        self.assertEqual(
            connect.calls[0].payload["data"]["attributes"],
            {"usesNonExemptEncryption": False},
        )

    def test_an_answered_build_is_left_alone(self):
        connect = FakeConnect({})
        build = {"id": "B", "attributes": {"usesNonExemptEncryption": False}}
        submit.declare_export_compliance(connect, build, {"attributes": {}})
        self.assertEqual(connect.calls, [])


def _temporary_directory():
    """A directory that `enterContext` cleans up when the test method ends."""
    return tempfile.TemporaryDirectory()


if __name__ == "__main__":
    unittest.main(verbosity=2)
