import { beforeEach, describe, expect, it } from "bun:test";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient, password } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type PublicUser = { id: string; name: string; email: string; systemRole: "admin" | "user" };

describe("profile", () => {
  it("renames the signed-in user", async () => {
    const person = await api.register("Profile Person");
    const updated = await api.json<PublicUser>("PATCH", "/api/auth/profile", person.session, { name: "  Ada King  " });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: person.user.id, name: "Ada King", systemRole: "user" });
    expect(updated.body).not.toHaveProperty("passwordHash");
    expect((await api.json<PublicUser>("GET", "/api/auth/me", person.session)).body.name).toBe("Ada King");
  });

  it("rejects invalid names and signed-out requests", async () => {
    const person = await api.register("Profile Checker");
    const invalid = await api.json<{ message: string }>("PATCH", "/api/auth/profile", person.session, { name: "" });
    expect(invalid.status).toBe(400);
    expect((await api.request("PATCH", "/api/auth/profile", undefined, { name: "Anonymous" })).status).toBe(401);
  });
});

describe("password changes", () => {
  it("requires the current password", async () => {
    const person = await api.register("Password Guard");
    const wrong = await api.json<{ message: string }>("PUT", "/api/auth/password", person.session, {
      currentPassword: "not-the-password",
      newPassword: "A-new-and-long-password",
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toBe("Current password is incorrect");
    expect((await api.request("PUT", "/api/auth/password", person.session, { currentPassword: password })).status).toBe(
      400,
    );
  });

  it("changes the password and ends every existing session", async () => {
    const person = await api.register("Password Changer");
    const secondDevice = await api.request("POST", "/api/auth/login", undefined, {
      email: person.user.email,
      password,
    });
    const secondSession = secondDevice.headers.get("set-cookie")?.split(";")[0] as string;
    const newPassword = "A-new-and-long-password";

    const changed = await api.request("PUT", "/api/auth/password", person.session, {
      currentPassword: password,
      newPassword,
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api.request("GET", "/api/auth/me", person.session)).status).toBe(401);
    expect((await api.request("GET", "/api/auth/me", secondSession)).status).toBe(401);

    const oldLogin = await api.request("POST", "/api/auth/login", undefined, { email: person.user.email, password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api.request("POST", "/api/auth/login", undefined, {
      email: person.user.email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);
  });
});

describe("sign out", () => {
  it("deletes the session and clears the cookie", async () => {
    const person = await api.register("Signing Out");
    const response = await api.request("POST", "/api/auth/logout", person.session);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api.request("GET", "/api/workspaces", person.session)).status).toBe(401);
  });
});

describe("system administration", () => {
  it("is limited to system admins", async () => {
    const person = await api.register("Regular User");
    expect((await api.request("GET", "/api/admin/users", person.session)).status).toBe(403);
    expect(
      (await api.request("PATCH", `/api/admin/users/${person.user.id}`, person.session, { systemRole: "admin" }))
        .status,
    ).toBe(403);
    expect((await api.request("GET", "/api/admin/users")).status).toBe(401);
  });

  it("lists users and changes their system role", async () => {
    const admin = await api.register("Admin Person");
    const colleague = await api.register("Admin Colleague");
    await api.promoteToAdmin(admin.user.id);

    const list = await api.json<Array<PublicUser & { createdAt: string }>>("GET", "/api/admin/users", admin.session);
    expect(list.status).toBe(200);
    const names = list.body.map((row) => row.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(list.body.find((row) => row.id === colleague.user.id)).toMatchObject({ systemRole: "user" });
    expect(list.body[0]).not.toHaveProperty("passwordHash");

    const promoted = await api.json<PublicUser>("PATCH", `/api/admin/users/${colleague.user.id}`, admin.session, {
      systemRole: "admin",
    });
    expect(promoted.body).toMatchObject({ id: colleague.user.id, systemRole: "admin" });
    expect((await api.request("GET", "/api/admin/users", colleague.session)).status).toBe(200);

    const demoted = await api.json<PublicUser>("PATCH", `/api/admin/users/${colleague.user.id}`, admin.session, {
      systemRole: "user",
    });
    expect(demoted.body.systemRole).toBe("user");
    expect((await api.request("GET", "/api/admin/users", colleague.session)).status).toBe(403);
  });

  it("refuses self-demotion, unknown users, and invalid roles", async () => {
    const admin = await api.register("Careful Admin");
    await api.promoteToAdmin(admin.user.id);
    const self = await api.json<{ message: string }>("PATCH", `/api/admin/users/${admin.user.id}`, admin.session, {
      systemRole: "user",
    });
    expect(self.status).toBe(400);
    expect(self.body.message).toBe("You cannot remove your own admin access");
    expect(
      (await api.request("PATCH", `/api/admin/users/${admin.user.id}`, admin.session, { systemRole: "admin" })).status,
    ).toBe(200);
    expect(
      (await api.request("PATCH", `/api/admin/users/${crypto.randomUUID()}`, admin.session, { systemRole: "admin" }))
        .status,
    ).toBe(404);
    expect(
      (await api.request("PATCH", `/api/admin/users/${admin.user.id}`, admin.session, { systemRole: "owner" })).status,
    ).toBe(400);
    expect(
      (await api.request("PATCH", "/api/admin/users/not-a-uuid", admin.session, { systemRole: "admin" })).status,
    ).toBe(400);
  });
});
