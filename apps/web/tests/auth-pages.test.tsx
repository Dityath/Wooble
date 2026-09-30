import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { FakeApi, failWith } from "./support/fake-api";
import { user } from "./support/fixtures";
import { renderRoute } from "./support/render";

let server: FakeApi;
let assign: ReturnType<typeof spyOn>;

beforeEach(() => {
  server = new FakeApi().install();
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  server.restore();
  assign.mockRestore();
});

describe("sign in", () => {
  it("signs in and returns to the page the visitor asked for", async () => {
    server.on("POST /api/auth/login", user());
    const { user: actor } = await renderRoute("/login?returnTo=%2Fcanvases%3FworkspaceId%3Dabc");

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    await actor.type(screen.getByLabelText("Email"), "ada@example.test");
    await actor.type(screen.getByLabelText("Password"), "correct horse battery");
    await actor.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/canvases?workspaceId=abc"));
    expect(server.requests("POST", "/api/auth/login")[0].body).toEqual({
      email: "ada@example.test",
      password: "correct horse battery",
    });
  });

  it("ignores return targets that leave the site", async () => {
    server.on("POST /api/auth/login", user());
    const { user: actor } = await renderRoute("/login?returnTo=%2F%2Fevil.example");
    await actor.type(await screen.findByLabelText("Email"), "ada@example.test");
    await actor.type(screen.getByLabelText("Password"), "secret");
    await actor.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/canvases"));
  });

  it("shows the API error and lets the visitor try again", async () => {
    server.on("POST /api/auth/login", failWith(401, "Invalid email or password"));
    const { user: actor } = await renderRoute("/login");
    await actor.type(await screen.findByLabelText("Email"), "ada@example.test");
    await actor.type(screen.getByLabelText("Password"), "wrong");
    await actor.click(screen.getByRole("button", { name: /sign in/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /sign in/i }).disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("reveals and hides the password on request", async () => {
    const { user: actor } = await renderRoute("/login");
    const password = await screen.findByLabelText<HTMLInputElement>("Password");
    expect(password.type).toBe("password");
    await actor.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    await actor.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
  });

  it("links to registration while keeping the return target", async () => {
    const { user: actor, router } = await renderRoute("/login?returnTo=%2Fprofile");
    await actor.click(await screen.findByRole("link", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/register"));
    expect(router.state.location.search).toEqual({ returnTo: "/profile" });
  });
});

describe("registration", () => {
  it("rejects mismatched passwords without calling the API", async () => {
    const { user: actor } = await renderRoute("/register");
    await actor.type(await screen.findByLabelText("Full name"), "Ada Lovelace");
    await actor.type(screen.getByLabelText("Email"), "ada@example.test");
    await actor.type(screen.getByLabelText("Password"), "a-long-password-1");
    await actor.type(screen.getByLabelText("Confirm password"), "a-long-password-2");
    await actor.click(screen.getByRole("button", { name: /create account/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("Passwords do not match.");
    expect(server.calls).toEqual([]);
  });

  it("creates the account and opens the canvas library", async () => {
    server.on("POST /api/auth/register", user());
    const { user: actor } = await renderRoute("/register");
    await actor.type(await screen.findByLabelText("Full name"), "Ada Lovelace");
    await actor.type(screen.getByLabelText("Email"), "ada@example.test");
    await actor.type(screen.getByLabelText("Password"), "a-long-password-1");
    await actor.type(screen.getByLabelText("Confirm password"), "a-long-password-1");
    await actor.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/canvases"));
    expect(server.requests("POST", "/api/auth/register")[0].body).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.test",
      password: "a-long-password-1",
      confirmPassword: "a-long-password-1",
    });
  });
});
