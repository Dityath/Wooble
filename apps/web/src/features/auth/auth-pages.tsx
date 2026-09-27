import { useState } from "react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Button, Card, Input, PasswordInput } from "../../components/ui";
import { api } from "../../lib/api";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { returnTo } = useSearch({ from: mode === "login" ? "/login" : "/register" });
  const next = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/canvases";
  return (
    <div className="auth-page">
      <div className="auth-side">
        <Link to="/login" className="auth-brand">
          <img src="/wooble-mark.svg" alt="" /> <span>wooble</span>
        </Link>
        <div className="auth-story">
          <h1>
            Structure without <em>visual noise.</em>
          </h1>
        </div>
        <span className="auth-footnote">A calm place for complex systems.</span>
      </div>
      <main className="auth-main">
        <Card className="auth-card">
          <h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
          <p>{mode === "login" ? "Sign in to continue." : "Create an account to get started."}</p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (mode === "register" && password !== confirmPassword) {
                setError("Passwords do not match.");
                return;
              }
              setBusy(true);
              setError("");
              try {
                const user =
                  mode === "login"
                    ? await api.login({ email, password })
                    : await api.register({ name, email, password, confirmPassword });
                queryClient.setQueryData(["me"], user);
                await router.invalidate();
                window.location.assign(next);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not continue");
                setBusy(false);
              }
            }}
          >
            {mode === "register" && (
              <label htmlFor="auth-name">
                Full name
                <Input
                  id="auth-name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  minLength={2}
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label htmlFor="auth-email">
              Email
              <Input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <div className="password-form-field">
              <label htmlFor="auth-password">Password</label>
              <PasswordInput
                id="auth-password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={mode === "register" ? 12 : undefined}
                required
              />
            </div>
            {mode === "register" && (
              <>
                <small>Use at least 12 characters.</small>
                <div className="password-form-field">
                  <label htmlFor="auth-confirm-password">Confirm password</label>
                  <PasswordInput
                    id="auth-confirm-password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                  />
                </div>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              <ArrowRight size={15} />
            </Button>
          </form>
          <div className="auth-switch">
            {mode === "login" ? "New to Wooble?" : "Already have an account?"}{" "}
            <Link to={mode === "login" ? "/register" : "/login"} search={{ returnTo }}>
              {mode === "login" ? "Create account" : "Sign in"}
            </Link>
          </div>
        </Card>
      </main>
    </div>
  );
}
export function LoginPage() {
  return <AuthPage mode="login" />;
}
export function RegisterPage() {
  return <AuthPage mode="register" />;
}
