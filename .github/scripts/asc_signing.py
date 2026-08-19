#!/usr/bin/env python3
"""Mint — and then destroy — an App Store signing identity for one CI run.

A GitHub runner is a fresh machine with an empty keychain, so it has nothing to
sign a distribution build with. Xcode's cloud signing is supposed to fill that
gap, but it reports `Cloud signing permission error` here and creates only a
*development* identity, which `-exportArchive` cannot use for the App Store.

So this script does explicitly what cloud signing does opaquely:

    mint     generate a private key and CSR, ask App Store Connect for an
             Apple Distribution certificate, create an App Store provisioning
             profile per bundle id, and install all of it into a throwaway
             keychain. Writes the export options the archive step needs.

    cleanup  revoke that certificate and delete those profiles.

The private key never leaves the runner and dies with it, which is the whole
point: a certificate whose private key is gone is landfill, and Apple caps how
many a team may hold at once. `cleanup` runs even when the build fails, so a
broken run does not leak a slot.

Certificates and profiles created by other people are never touched — the state
file records exactly what this run made, and cleanup reads only that.
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
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

BASE = "https://api.appstoreconnect.apple.com"
TEAM_ID = "SXHVCQXJHZ"
APP_BUNDLE = "com.pathors.parley.ios"
KEYBOARD_BUNDLE = "com.pathors.parley.ios.keyboard"

# Everything this run creates is named with this prefix so a human reading the
# Apple developer portal can tell where it came from, and so cleanup can sanity
# check that it is deleting its own work.
TAG = "parley-ci"

RUNNER_TEMP = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
STATE = RUNNER_TEMP / "asc-signing-state.json"
KEYCHAIN = RUNNER_TEMP / "parley-signing.keychain-db"
KEYCHAIN_PASSWORD = "parley-ci"
PROFILE_DIR = Path.home() / "Library/MobileDevice/Provisioning Profiles"


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
        detail = ""
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

    `quiet` suppresses output on success only — several of the `security`
    invocations below print the whole certificate on success, which is noise,
    but swallowing their diagnostics on failure turns a one-line explanation
    into an unexplained exit code.
    """
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(
            f"$ {' '.join(args)}\n"
            f"exit {proc.returncode}\n"
            f"{proc.stdout}{proc.stderr}"
        )
    if not quiet and proc.stdout:
        print(proc.stdout, end="")


# --------------------------------------------------------------------------
# mint


def mint() -> None:
    state: dict = {"certificate_id": None, "profile_ids": []}
    STATE.write_text(json.dumps(state))  # exists before the first write, so
    # cleanup has something to read even if we die halfway through

    print("▸ Generating a private key and CSR")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(NameOID.COMMON_NAME, f"{TAG} distribution"),
                    x509.NameAttribute(NameOID.ORGANIZATION_NAME, TEAM_ID),
                    x509.NameAttribute(NameOID.COUNTRY_NAME, "TW"),
                ]
            )
        )
        .sign(key, hashes.SHA256())
    )
    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode()

    print("▸ Requesting an Apple Distribution certificate")
    created = api(
        "POST",
        "/v1/certificates",
        {
            "data": {
                "type": "certificates",
                "attributes": {"certificateType": "DISTRIBUTION", "csrContent": csr_pem},
            }
        },
    )["data"]
    state["certificate_id"] = created["id"]
    STATE.write_text(json.dumps(state))
    cert_der = base64.b64decode(created["attributes"]["certificateContent"])
    cert = x509.load_der_x509_certificate(cert_der)
    identity = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    print(f"  {identity}  (id {created['id']})")

    print("▸ Installing it into a throwaway keychain")
    # Deliberately *not* `BestAvailableEncryption`. Modern cryptography writes
    # PKCS#12 with AES-256 and PBKDF2, and macOS `security import` cannot read
    # that container at all — it fails with a bare exit 1. Security's importer
    # still wants the PKCS#12 v1 encryption from the 1990s, so ask for it by
    # name. The password guards a file that exists for seconds on a throwaway
    # runner, so the weak cipher costs nothing.
    legacy = (
        serialization.PrivateFormat.PKCS12.encryption_builder()
        .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
        .hmac_hash(hashes.SHA1())
        .build(KEYCHAIN_PASSWORD.encode())
    )
    p12 = pkcs12.serialize_key_and_certificates(
        name=TAG.encode(), key=key, cert=cert, cas=None, encryption_algorithm=legacy
    )
    p12_path = RUNNER_TEMP / "signing.p12"
    p12_path.write_bytes(p12)
    p12_path.chmod(0o600)

    run("security", "create-keychain", "-p", KEYCHAIN_PASSWORD, str(KEYCHAIN))
    run("security", "set-keychain-settings", "-lut", "21600", str(KEYCHAIN))
    run("security", "unlock-keychain", "-p", KEYCHAIN_PASSWORD, str(KEYCHAIN))
    run(
        "security", "import", str(p12_path),
        "-k", str(KEYCHAIN),
        "-P", KEYCHAIN_PASSWORD,
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
    # Prepend rather than replace: the default keychain still holds what the
    # rest of the toolchain expects to find.
    existing = subprocess.run(
        ["security", "list-keychains", "-d", "user"],
        check=True, capture_output=True, text=True,
    ).stdout.split()
    run(
        "security", "list-keychains", "-d", "user",
        "-s", str(KEYCHAIN), *[k.strip('"') for k in existing],
    )
    p12_path.unlink()

    print("▸ Creating App Store provisioning profiles")
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    profiles: dict[str, str] = {}
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
        # A profile carries exactly the capabilities enabled on its bundle id,
        # so print them: a profile missing one fails export with a message about
        # entitlements that never mentions the portal.
        caps = api("GET", f"/v1/bundleIds/{bundle_id}/bundleIdCapabilities?limit=50")
        enabled = sorted(
            c["attributes"].get("capabilityType", "?") for c in caps.get("data", [])
        )
        print(f"  {bundle} capabilities: {', '.join(enabled) or '(none)'}")
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
                            "data": [
                                {"type": "certificates", "id": state["certificate_id"]}
                            ]
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
        (PROFILE_DIR / f"{uuid}.mobileprovision").write_bytes(
            base64.b64decode(profile["attributes"]["profileContent"])
        )
        profiles[bundle] = name
        print(f"  {name}  ({uuid})")

    print("▸ Writing export options")
    # Manual signing, not automatic: automatic asks Xcode to go and find an
    # identity, which is the path that failed. Everything it would look for now
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
            fh.write(f"keychain={KEYCHAIN}\n")


# --------------------------------------------------------------------------
# cleanup


def cleanup() -> None:
    if not STATE.exists():
        print("nothing to clean up")
        return
    state = json.loads(STATE.read_text())

    for profile_id in state.get("profile_ids", []):
        try:
            api("DELETE", f"/v1/profiles/{profile_id}")
            print(f"▸ Deleted profile {profile_id}")
        except SystemExit as e:
            print(f"  could not delete profile {profile_id}: {e}")

    if cert_id := state.get("certificate_id"):
        # Revoking is what keeps this sustainable. The private key died with the
        # runner, so the certificate can never be used again by anyone — leaving
        # it would burn one of the team's distribution slots for nothing.
        try:
            api("DELETE", f"/v1/certificates/{cert_id}")
            print(f"▸ Revoked certificate {cert_id}")
        except SystemExit as e:
            print(f"  could not revoke certificate {cert_id}: {e}")

    if KEYCHAIN.exists():
        subprocess.run(
            ["security", "delete-keychain", str(KEYCHAIN)], check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("▸ Deleted the throwaway keychain")

    STATE.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"mint", "cleanup"}:
        raise SystemExit("usage: asc_signing.py mint|cleanup")
    (mint if sys.argv[1] == "mint" else cleanup)()
