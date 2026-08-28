#!/usr/bin/env python3
"""Install the App Store signing identity on a CI runner, and tidy up after.

A GitHub runner is a fresh machine with an empty keychain, so it has nothing to
sign a distribution build with, and Xcode's cloud signing does not fill the gap:
it produces only a *development* identity and then reports the shortfall as
`Cloud signing permission error` during export.

Worse, it does not stop producing them. Every runner is new, so every archive
run with `-allowProvisioningUpdates` minted another certificate named "Created
via API", and a team may hold only so many at once. On 2026-08-28 the eleventh
one hit the cap and the archive died with `Choose a certificate to revoke` — a
message about a limit nobody knew was being consumed. So nothing in this
workflow may be allowed to mint anything; both the archive and the export sign
manually against what is installed here.

    install  import the team's distribution certificate from a secret, create an
             App Store provisioning profile per bundle id against it, install
             those profiles where Xcode looks for them, and write the xcconfig
             the archive signs with and the export options the export needs.

    cleanup  delete those profiles and the keychain.

**Nothing here creates or revokes a certificate.** An earlier version minted one
per run and revoked it afterwards, which worked but sent the account holder a
"your certificate has been revoked" mail on every release — noise that trains
people to ignore exactly the mail they should read. The certificate now lives in
`APPLE_IOS_DIST_P12`; its private key was generated on a developer's own machine
and only the CSR ever travelled, so the same identity is also in that machine's
keychain and a hand-built release signs with it too.

Provisioning profiles *are* still made and destroyed per run. Creating them is
silent, they cost nothing, and a fresh one can never be stale against the
certificate or the bundle ids' current capabilities.
"""

from __future__ import annotations

import base64
import json
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

import jwt
import requests
from cryptography import x509

BASE = "https://api.appstoreconnect.apple.com"
TEAM_ID = "SXHVCQXJHZ"
APP_BUNDLE = "com.pathors.parley.ios"
KEYBOARD_BUNDLE = "com.pathors.parley.ios.keyboard"

# Everything this run creates is named with this prefix, so a human reading the
# developer portal can tell where it came from and cleanup can sanity check that
# it is deleting its own work.
TAG = "parley-ci"

RUNNER_TEMP = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
STATE = RUNNER_TEMP / "asc-signing-state.json"
KEYCHAIN = RUNNER_TEMP / "parley-signing.keychain-db"
KEYCHAIN_PASSWORD = "parley-ci"
XCCONFIG = RUNNER_TEMP / "parley-ci-signing.xcconfig"

# Both, because which one Xcode reads depends on the version and the runner
# image moves: 15 and earlier used the MobileDevice path, 16 introduced the
# UserData one and still reads the old one. Writing a profile twice costs
# nothing; guessing wrong costs a twenty-minute run and reports itself as
# `No profiles for 'com.pathors.parley.ios' were found`.
PROFILE_DIRS = (
    Path.home() / "Library/MobileDevice/Provisioning Profiles",
    Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
)


# --------------------------------------------------------------------------
# App Store Connect


def token() -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": os.environ["ASC_ISSUER_ID"].strip(),
            "iat": now,
            "exp": now + 900,
            "aud": "appstoreconnect-v1",
        },
        os.environ["ASC_KEY_CONTENT"],
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"].strip(), "typ": "JWT"},
    )


def api(method: str, path: str, payload: dict | None = None) -> dict:
    r = requests.request(
        method,
        BASE + path,
        headers={"Authorization": f"Bearer {token()}"},
        json=payload,
        timeout=60,
    )
    if r.status_code >= 400:
        try:
            detail = "\n".join(
                f"  {e.get('title')}: {e.get('detail')}" for e in r.json().get("errors", [])
            )
        except ValueError:
            detail = r.text[:500]
        raise SystemExit(f"{method} {path} → {r.status_code}\n{detail}")
    return r.json() if r.content else {}


def run(*args: str, quiet: bool = False) -> None:
    """Run a command, and on failure say what it said.

    `quiet` suppresses output on success only — several of the `security` calls
    below print a whole certificate when they succeed, which is noise, but
    swallowing their diagnostics on failure turns a one-line explanation into an
    unexplained exit code.
    """
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(
            f"$ {' '.join(args)}\nexit {proc.returncode}\n{proc.stdout}{proc.stderr}"
        )
    if not quiet and proc.stdout:
        print(proc.stdout, end="")


# --------------------------------------------------------------------------
# install


def install() -> None:
    state: dict = {"profile_ids": []}
    STATE.write_text(json.dumps(state))  # exists before the first profile, so
    # cleanup has something to read even if we die halfway through

    p12_b64 = os.environ.get("IOS_DIST_P12", "").strip()
    p12_password = os.environ.get("IOS_DIST_P12_PASSWORD", "")
    if not p12_b64 or not p12_password:
        raise SystemExit(
            "APPLE_IOS_DIST_P12 / APPLE_IOS_DIST_P12_PASSWORD are not set.\n"
            "See ios/RELEASING.md — the distribution identity is stored as a "
            "secret rather than minted per run."
        )

    print("▸ Importing the distribution identity")
    p12 = base64.b64decode(p12_b64)
    p12_path = RUNNER_TEMP / "signing.p12"
    p12_path.write_bytes(p12)
    p12_path.chmod(0o600)

    run("security", "create-keychain", "-p", KEYCHAIN_PASSWORD, str(KEYCHAIN))
    run("security", "set-keychain-settings", "-lut", "21600", str(KEYCHAIN))
    run("security", "unlock-keychain", "-p", KEYCHAIN_PASSWORD, str(KEYCHAIN))
    run(
        "security", "import", str(p12_path),
        "-k", str(KEYCHAIN),
        "-P", p12_password,
        "-T", "/usr/bin/codesign",
        "-T", "/usr/bin/security",
        quiet=True,
    )
    # Without this, codesign blocks on a GUI prompt that a runner cannot answer.
    run(
        "security", "set-key-partition-list",
        "-S", "apple-tool:,apple:",
        "-s", "-k", KEYCHAIN_PASSWORD, str(KEYCHAIN),
        quiet=True,
    )
    # Prepend rather than replace: the default keychain still holds what the rest
    # of the toolchain expects to find.
    existing = subprocess.run(
        ["security", "list-keychains", "-d", "user"],
        check=True, capture_output=True, text=True,
    ).stdout.split()
    run(
        "security", "list-keychains", "-d", "user",
        "-s", str(KEYCHAIN), *[k.strip('"') for k in existing],
    )
    p12_path.unlink()

    # Read the serial out of the container so the profiles below reference the
    # certificate that is actually in this keychain. Matching by type alone would
    # silently pick a different distribution certificate the day the team holds
    # two, and the resulting profile would not match what signs the binary.
    from cryptography.hazmat.primitives.serialization import pkcs12 as _p12

    _, cert, _ = _p12.load_key_and_certificates(p12, p12_password.encode())
    if cert is None:
        raise SystemExit("the stored .p12 contains no certificate")
    serial = f"{cert.serial_number:X}"
    subject = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
    print(f"  {subject}")
    print(f"  serial {serial}  expires {cert.not_valid_after_utc:%Y-%m-%d}")

    matches = [
        c
        for c in api("GET", "/v1/certificates?limit=200")["data"]
        if c["attributes"].get("serialNumber", "").upper().lstrip("0")
        == serial.upper().lstrip("0")
    ]
    if not matches:
        raise SystemExit(
            f"no certificate on the team has serial {serial}. The stored .p12 "
            "has been revoked or belongs to another team — mint a new identity, "
            "see ios/RELEASING.md."
        )
    certificate_id = matches[0]["id"]
    print(f"  App Store Connect id {certificate_id}")

    print("▸ Creating App Store provisioning profiles")
    for d in PROFILE_DIRS:
        d.mkdir(parents=True, exist_ok=True)
    profiles: dict[str, str] = {}
    uuids: dict[str, str] = {}
    # Match the identifier here rather than with `filter[identifier]`. That
    # filter is not an exact match: asking it for `com.pathors.parley.ios` also
    # returns `com.pathors.parley.ios.keyboard`, and with `limit=1` the profile
    # for the app came back bound to the keyboard's app id — which surfaces much
    # later as four unrelated-looking entitlement errors during export.
    registered = {
        b["attributes"]["identifier"]: b["id"]
        for b in api("GET", "/v1/bundleIds?limit=200")["data"]
    }

    for bundle in (APP_BUNDLE, KEYBOARD_BUNDLE):
        bundle_id = registered.get(bundle)
        if not bundle_id:
            raise SystemExit(
                f"bundle id {bundle} is not registered on team {TEAM_ID}.\n"
                f"registered: {', '.join(sorted(registered))}"
            )
        # A profile carries exactly the capabilities enabled on its bundle id, so
        # print them: when one is missing, export complains about entitlements
        # without ever mentioning the developer portal.
        #
        # No `limit` — relationship endpoints reject it — and never fatal. A
        # diagnostic that can fail the build is worse than no diagnostic, which
        # is what happened the first time this line existed.
        try:
            caps = api("GET", f"/v1/bundleIds/{bundle_id}/bundleIdCapabilities")
            enabled = sorted(
                c["attributes"].get("capabilityType", "?") for c in caps.get("data", [])
            )
            print(f"  {bundle} capabilities: {', '.join(enabled) or '(none)'}")
        except SystemExit as e:
            print(f"  {bundle} capabilities: could not read ({e})")

        # A profile of this name may survive a run that died before cleanup.
        # Apple rejects a duplicate name, so clear the old one first.
        for stale in api("GET", "/v1/profiles?limit=200")["data"]:
            if stale["attributes"].get("name") == f"{TAG} {bundle}":
                print(f"  removing a leftover profile from an earlier run")
                api("DELETE", f"/v1/profiles/{stale['id']}")

        name = f"{TAG} {bundle}"
        profile = api(
            "POST",
            "/v1/profiles",
            {
                "data": {
                    "type": "profiles",
                    "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
                    "relationships": {
                        "bundleId": {"data": {"type": "bundleIds", "id": bundle_id}},
                        "certificates": {
                            "data": [{"type": "certificates", "id": certificate_id}]
                        },
                    },
                }
            },
        )["data"]
        state["profile_ids"].append(profile["id"])
        STATE.write_text(json.dumps(state))

        # Read back what was actually bound. A profile pointing at the wrong app
        # id is only reported by `exportArchive`, twenty minutes later, as an
        # entitlements mismatch — which is not a sentence anybody connects to
        # this line.
        bound = api("GET", f"/v1/profiles/{profile['id']}/bundleId")["data"]
        if bound["attributes"]["identifier"] != bundle:
            raise SystemExit(
                f"profile {name} came back bound to "
                f"{bound['attributes']['identifier']}, not {bundle}"
            )

        uuid = profile["attributes"]["uuid"]
        content = base64.b64decode(profile["attributes"]["profileContent"])
        for d in PROFILE_DIRS:
            (d / f"{uuid}.mobileprovision").write_bytes(content)
        profiles[bundle] = name
        uuids[bundle] = uuid
        print(f"  {name}  ({uuid})")

    write_signing_xcconfig(profiles)

    print("▸ Writing export options")
    # Manual signing, not automatic: automatic asks Xcode to go and find an
    # identity, which is the path that fails. Everything it would look for now
    # exists and is named here explicitly.
    options = {
        "method": "app-store-connect",
        "teamID": TEAM_ID,
        "signingStyle": "manual",
        "signingCertificate": "Apple Distribution",
        "provisioningProfiles": profiles,
        "uploadSymbols": True,
        "manageAppVersionAndBuildNumber": False,
    }
    out = RUNNER_TEMP / "ExportOptions.plist"
    out.write_bytes(plistlib.dumps(options))
    print(f"  {out}")

    if gh_out := os.environ.get("GITHUB_OUTPUT"):
        with open(gh_out, "a") as fh:
            fh.write(f"export_options={out}\n")
            fh.write(f"xcconfig={XCCONFIG}\n")
            fh.write(f"keychain={KEYCHAIN}\n")
            fh.write(f"app_profile={profiles[APP_BUNDLE]}\n")
            fh.write(f"keyboard_profile={profiles[KEYBOARD_BUNDLE]}\n")
            fh.write(f"app_profile_uuid={uuids[APP_BUNDLE]}\n")
            fh.write(f"keyboard_profile_uuid={uuids[KEYBOARD_BUNDLE]}\n")


def write_signing_xcconfig(profiles: dict[str, str]) -> None:
    """Write the xcconfig the archive signs with.

    Two bundle ids need two different profiles, and a build setting given on the
    xcodebuild command line applies to *every* target at once — so
    `PROVISIONING_PROFILE_SPECIFIER=…` would hand the app's profile to the
    keyboard extension as well and the archive would fail on a mismatch.

    The way out is that `PRODUCT_BUNDLE_IDENTIFIER` is already per-target, so it
    can name the setting to read: `:identifier` rewrites
    `com.pathors.parley.ios` into `com_pathors_parley_ios`, and each target
    resolves the indirection to its own profile. A target with no entry here
    resolves it to empty, which is the same as not setting it.

    This has to be an xcconfig rather than command-line settings for a second
    reason: `project.yml` commits `CODE_SIGN_STYLE = Automatic` as a *target*
    build setting, because that is what a developer archiving on their own Mac
    wants, and a target setting outranks a command-line one. `xcodebuild
    -xcconfig` is the one lever above both (see `man xcodebuild`), so CI can
    override the committed default without the committed default being wrong.
    """
    lines = [
        "// Generated per run by .github/scripts/asc_signing.py. Not committed:",
        "// it names profiles that exist only for the length of this run.",
        "",
    ]
    for bundle, name in profiles.items():
        key = "".join(c if c.isalnum() else "_" for c in bundle)
        lines.append(f"PARLEY_CI_PROFILE_{key} = {name}")
    lines += [
        "",
        "CODE_SIGN_STYLE = Manual",
        f"DEVELOPMENT_TEAM = {TEAM_ID}",
        "// By name, not by fingerprint: the identity is whatever",
        "// APPLE_IOS_DIST_P12 currently holds, and replacing it must not mean",
        "// editing a script.",
        "CODE_SIGN_IDENTITY = Apple Distribution",
        "PROVISIONING_PROFILE_SPECIFIER = "
        "$(PARLEY_CI_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:identifier))",
        "",
    ]
    print("▸ Writing the archive signing xcconfig")
    XCCONFIG.write_text("\n".join(lines))
    print(f"  {XCCONFIG}")


# --------------------------------------------------------------------------
# cleanup


def cleanup() -> None:
    if not STATE.exists():
        print("nothing to clean up")
        return
    state = json.loads(STATE.read_text())

    # Profiles only. The certificate is the team's and outlives every run; the
    # whole point of storing it in a secret was to stop revoking it.
    for profile_id in state.get("profile_ids", []):
        try:
            api("DELETE", f"/v1/profiles/{profile_id}")
            print(f"▸ Deleted profile {profile_id}")
        except SystemExit as e:
            print(f"  could not delete profile {profile_id}: {e}")

    if KEYCHAIN.exists():
        subprocess.run(
            ["security", "delete-keychain", str(KEYCHAIN)], check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("▸ Deleted the throwaway keychain")

    STATE.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"install", "cleanup"}:
        raise SystemExit("usage: asc_signing.py install|cleanup")
    (install if sys.argv[1] == "install" else cleanup)()
