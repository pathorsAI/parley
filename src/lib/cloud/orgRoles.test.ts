import { describe, it, expect } from "vitest";
import type { CloudInvitation, CloudOrgMember } from "./types";
import {
  canChangeRole,
  canLeave,
  canManage,
  canRemove,
  canTransferTo,
  classifyInviteEmails,
  hoursUntilExpiry,
  isInvitationExpired,
  isInvitationLive,
  ownerCount,
  primaryRole,
  roleOptions,
  splitEmails,
} from "./orgRoles";

const m = (id: string, role: string, email = `${id}@x.com`): CloudOrgMember => ({ id, userId: `u-${id}`, role, email });
const NOW = Date.parse("2026-10-06T00:00:00Z");
const inv = (email: string, expiresAt: string, status = "pending"): CloudInvitation => ({
  id: email, organizationId: "o", email, role: "member", status, expiresAt,
});

describe("roles", () => {
  it("reads comma-separated roles and ranks them", () => {
    expect(primaryRole("member,admin")).toBe("admin");
    expect(primaryRole("owner")).toBe("owner");
    expect(primaryRole(undefined)).toBe("member");
    expect(canManage("admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(ownerCount([m("a", "owner"), m("b", "admin"), m("c", "owner,admin")])).toBe(2);
  });
});

describe("changing roles", () => {
  it("lets owners and admins edit plain members and admins", () => {
    expect(canChangeRole("admin", m("b", "member"), false, 1)).toBe(true);
    expect(canChangeRole("owner", m("b", "admin"), false, 1)).toBe(true);
    expect(canChangeRole("member", m("b", "member"), false, 1)).toBe(false);
  });
  it("keeps owners out of an admin's reach", () => {
    expect(canChangeRole("admin", m("o", "owner"), false, 1)).toBe(false);
    expect(canChangeRole("owner", m("o", "owner"), false, 2)).toBe(true);
  });
  it("lets an owner step down only while another owner remains", () => {
    expect(canChangeRole("owner", m("me", "owner"), true, 1)).toBe(false);
    expect(canChangeRole("owner", m("me", "owner"), true, 2)).toBe(true);
    expect(canChangeRole("admin", m("me", "admin"), true, 1)).toBe(false);
  });
  it("offers owner in the picker only to someone who already is one", () => {
    expect(roleOptions(m("b", "member"))).toEqual(["admin", "member"]);
    expect(roleOptions(m("o", "owner"))).toEqual(["owner", "admin", "member"]);
  });
});

describe("removing, transferring, leaving", () => {
  it("never removes yourself and never the last owner", () => {
    expect(canRemove("owner", m("me", "owner"), true, 2)).toBe(false);
    expect(canRemove("owner", m("o", "owner"), false, 1)).toBe(false);
    expect(canRemove("owner", m("o", "owner"), false, 2)).toBe(true);
    expect(canRemove("admin", m("o", "owner"), false, 2)).toBe(false);
    expect(canRemove("admin", m("b", "admin"), false, 1)).toBe(true);
    expect(canRemove("member", m("b", "member"), false, 1)).toBe(false);
  });
  it("transfers only from an owner to a non-owner", () => {
    expect(canTransferTo("owner", m("b", "admin"), false)).toBe(true);
    expect(canTransferTo("owner", m("o", "owner"), false)).toBe(false);
    expect(canTransferTo("admin", m("b", "member"), false)).toBe(false);
  });
  it("blocks the last owner from leaving", () => {
    expect(canLeave("owner", 1)).toBe(false);
    expect(canLeave("owner", 2)).toBe(true);
    expect(canLeave("member", 1)).toBe(true);
  });
});

describe("invitation expiry", () => {
  it("treats past expiry as expired and not acceptable", () => {
    const old = inv("a@x.com", "2026-10-05T00:00:00Z");
    expect(isInvitationExpired(old, NOW)).toBe(true);
    expect(isInvitationLive(old, NOW)).toBe(false);
    expect(hoursUntilExpiry(old, NOW)).toBe(0);
  });
  it("counts hours left on a live one, and ignores non-pending states", () => {
    const fresh = inv("a@x.com", "2026-10-07T12:00:00Z");
    expect(isInvitationLive(fresh, NOW)).toBe(true);
    expect(hoursUntilExpiry(fresh, NOW)).toBe(36);
    expect(isInvitationLive({ ...fresh, status: "canceled" }, NOW)).toBe(false);
  });
  it("never expires without an expiry", () => {
    expect(isInvitationExpired({ expiresAt: undefined }, NOW)).toBe(false);
    expect(hoursUntilExpiry({ expiresAt: undefined }, NOW)).toBeNull();
  });
});

describe("invite input", () => {
  it("splits pasted lists and angle-bracket addresses", () => {
    expect(splitEmails("a@x.com, b@x.com\nc@x.com; <d@x.com>")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
    expect(splitEmails("  ")).toEqual([]);
  });
  it("flags bad, existing, already-invited and repeated addresses", () => {
    const out = classifyInviteEmails(
      ["new@x.com", "nope", "amy@x.com", "LISA@x.com", "new@x.com", "old@x.com"],
      [m("amy", "member", "amy@x.com")],
      [inv("lisa@x.com", "2026-10-07T00:00:00Z"), inv("old@x.com", "2026-10-01T00:00:00Z")],
      NOW,
    );
    expect(out.map((o) => o.status)).toEqual(["ok", "invalid", "member", "invited", "duplicate", "ok"]);
  });
  it("rejects malformed shapes", () => {
    const bad = ["@x.com", "a@", "a@x", "a@x.", "a@.com", "a@@x.com", "a b@x.com", "a@x@y.com"];
    expect(classifyInviteEmails(bad, [], [], NOW).every((o) => o.status === "invalid")).toBe(true);
    expect(classifyInviteEmails(["first.last+tag@sub.example.co"], [], [], NOW)[0].status).toBe("ok");
  });
});
