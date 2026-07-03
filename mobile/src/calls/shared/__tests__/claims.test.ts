import {
  claim,
  release,
  releaseIfClaimed,
  forceRelease,
  isClaimed,
  onClaimReleased,
  _resetForTests,
} from "../claims";

beforeEach(() => {
  _resetForTests();
});

describe("claims registry — surface scoping", () => {
  it("claims are independent per surface", () => {
    const p2p = claim("p2p", 1, 100);
    const ring = claim("groupRing", 2, 200);
    expect(p2p).not.toBeNull();
    expect(ring).not.toBeNull();
    expect(isClaimed("p2p", 1, 100)).toBe(true);
    expect(isClaimed("groupRing", 2, 200)).toBe(true);
  });

  it("a group ring claim never blocks or matches the p2p surface", () => {
    claim("groupRing", 5, 500);
    expect(isClaimed("p2p")).toBe(false);
    expect(claim("p2p", 5, 500)).not.toBeNull();
  });

  it("duplicate claim for the same call on the same surface is refused", () => {
    expect(claim("p2p", 1, 100)).not.toBeNull();
    expect(claim("p2p", 1, 100)).toBeNull();
  });

  it("claim with null identifiers is refused", () => {
    expect(claim("p2p", null, 100)).toBeNull();
    expect(claim("p2p", 1, undefined)).toBeNull();
  });
});

describe("claims registry — owner tokens", () => {
  it("release requires the owning token; a superseded token is a no-op", () => {
    const first = claim("p2p", 1, 100)!;
    // A NEW call supersedes the slot (different key is allowed to overwrite).
    const second = claim("p2p", 2, 100)!;
    // Releasing with the stale first token must NOT drop the second claim.
    release(first);
    expect(isClaimed("p2p", 2, 100)).toBe(true);
    // The rightful owner releases fine.
    release(second);
    expect(isClaimed("p2p")).toBe(false);
  });

  it("releaseIfClaimed only releases a matching (surface, call)", () => {
    claim("groupRing", 7, 700);
    // Wrong call → no-op.
    releaseIfClaimed("groupRing", 8, 800);
    expect(isClaimed("groupRing", 7, 700)).toBe(true);
    // Wrong surface → no-op.
    releaseIfClaimed("p2p", 7, 700);
    expect(isClaimed("groupRing", 7, 700)).toBe(true);
    // Exact match → released.
    releaseIfClaimed("groupRing", 7, 700);
    expect(isClaimed("groupRing")).toBe(false);
  });
});

describe("claims registry — end listeners (legacy banner contract)", () => {
  it("forceRelease('p2p') notifies listeners even with no active claim", () => {
    const seen: number[] = [];
    onClaimReleased(() => seen.push(1));
    forceRelease("p2p");
    expect(seen).toHaveLength(1);
  });

  it("group-surface releases never fire the p2p end listeners", () => {
    const seen: number[] = [];
    onClaimReleased(() => seen.push(1));
    claim("groupRing", 1, 100);
    forceRelease("groupRing");
    releaseIfClaimed("groupRing", 1, 100);
    expect(seen).toHaveLength(0);
  });

  it("token release of a p2p claim notifies listeners", () => {
    const seen: number[] = [];
    onClaimReleased(() => seen.push(1));
    const t = claim("p2p", 1, 100)!;
    release(t);
    expect(seen).toHaveLength(1);
  });
});