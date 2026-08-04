import { qk } from "../queryKeys";

/**
 * The whole value of the key factory rests on one invariant: a mutation that
 * invalidates a PARENT key must actually match the child keys its screens
 * registered under. React Query matches by structural prefix, so if a child
 * key ever stops starting with its parent, the invalidation silently no-ops
 * and users see stale data with no error anywhere.
 *
 * These tests make that invariant executable.
 */

/** True when `key` begins with every element of `prefix`, in order. */
function hasPrefix(key: readonly unknown[], prefix: readonly unknown[]) {
  return (
    key.length >= prefix.length &&
    prefix.every((segment, i) => Object.is(key[i], segment))
  );
}

describe("query key factory", () => {
  describe("parent keys are prefixes of their filtered children", () => {
    const cases: Array<{
      name: string;
      parent: readonly unknown[];
      children: Array<readonly unknown[]>;
    }> = [
      {
        name: "admin.projects",
        parent: qk.admin.projects(),
        children: [
          qk.admin.projectList(true),
          qk.admin.projectList(false),
          qk.admin.projectList(undefined),
        ],
      },
      {
        name: "admin.departments",
        parent: qk.admin.departments(),
        children: [qk.admin.departmentList(7), qk.admin.departmentList(null)],
      },
      {
        name: "admin.teams",
        parent: qk.admin.teams(),
        children: [qk.admin.teamList(7), qk.admin.teamList(null)],
      },
      {
        name: "admin.roleRequests",
        parent: qk.admin.roleRequests(),
        children: [qk.admin.roleRequestList("pending")],
      },
      {
        name: "admin.users",
        parent: qk.admin.users(),
        children: [qk.admin.userList("ann", "active"), qk.admin.userList("", null)],
      },
      {
        name: "admin.addPeople",
        parent: qk.admin.addPeople(),
        children: [qk.admin.addPeopleOrgs(), qk.admin.addPeopleRefData(3)],
      },
      {
        name: "tasks.sprint",
        parent: qk.tasks.sprint(),
        children: [qk.tasks.sprintTasks(12)],
      },
      {
        name: "org.departments",
        parent: qk.org.departments(),
        children: [qk.org.departmentList(4), qk.org.departmentList(null)],
      },
      {
        name: "org.teams",
        parent: qk.org.teams(),
        children: [qk.org.teamList(4)],
      },
    ];

    it.each(cases)("$name cascades to its children", ({ parent, children }) => {
      for (const child of children) {
        expect(hasPrefix(child, parent)).toBe(true);
      }
    });
  });

  describe("root keys are prefixes of everything in their namespace", () => {
    it("qk.admin.all() matches every admin key", () => {
      const root = qk.admin.all();
      const keys = [
        qk.admin.home(),
        qk.admin.payroll(),
        qk.admin.audit("30d", 2),
        qk.admin.salarySlips(9),
        qk.admin.projectList(true),
        qk.admin.userList("x", "y"),
      ];
      for (const key of keys) expect(hasPrefix(key, root)).toBe(true);
    });

    it("qk.leaves.all() matches every leaves key", () => {
      const root = qk.leaves.all();
      const keys = [
        qk.leaves.balance(2026),
        qk.leaves.history("2026-08"),
        qk.leaves.policies(),
        qk.leaves.allBalances(),
      ];
      for (const key of keys) expect(hasPrefix(key, root)).toBe(true);
    });
  });

  describe("keys are stable and distinct", () => {
    it("returns an equal key for equal arguments (no cache thrash)", () => {
      expect(qk.admin.projectList(true)).toEqual(qk.admin.projectList(true));
      expect(qk.attendance.analytics("30d", "a", "b")).toEqual(
        qk.attendance.analytics("30d", "a", "b"),
      );
    });

    it("distinguishes different arguments", () => {
      expect(qk.admin.projectList(true)).not.toEqual(
        qk.admin.projectList(false),
      );
      expect(qk.member.detail(1)).not.toEqual(qk.member.detail(2));
    });

    it("normalizes undefined and null to the same segment", () => {
      // Both mean "no filter" — they must NOT produce two separate caches.
      expect(qk.admin.projectList(undefined)).toEqual(
        qk.admin.projectList(null),
      );
      expect(qk.admin.teamList(undefined)).toEqual(qk.admin.teamList(null));
    });

    it("keeps sibling namespaces from colliding", () => {
      // ["admin","departments"] and ["org","departments"] are different caches.
      expect(qk.admin.departments()).not.toEqual(qk.org.departments());
      expect(qk.admin.salarySlips(1)).not.toEqual(qk.org.salarySlips());
    });
  });

  describe("matches the literal keys already used in the app", () => {
    // Pins the factory to the exact arrays the screens currently register,
    // so adopting it is provably a no-op refactor rather than a cache reset.
    it.each([
      [qk.tasks.all(), ["tasks"]],
      [qk.tasks.sprint(), ["tasks", "sprint"]],
      [qk.tasks.sprints(), ["tasks", "sprints"]],
      [qk.sprints.list(), ["sprints", "list"]],
      [qk.leaves.allBalances(), ["leaves", "allBalances"]],
      [qk.notifications.all(), ["notifications"]],
      [qk.profile.notificationPrefs(), ["profile", "notificationPrefs"]],
      [qk.team.attendance(), ["team", "attendance"]],
      [qk.org.chart(), ["org", "chart"]],
      [qk.org.taskLabels(), ["org", "taskLabels"]],
      [qk.admin.platformAccess(), ["admin", "platformAccess"]],
      [qk.admin.addPeopleOrgs(), ["admin", "addPeople", "orgs"]],
      [qk.admin.projectList(true), ["admin", "projects", true]],
      [qk.admin.audit("7d", 1), ["admin", "audit", "7d", 1]],
    ])("%j", (actual, expected) => {
      expect(actual).toEqual(expected);
    });
  });
});
