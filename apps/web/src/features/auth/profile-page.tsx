import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Moon, Pencil, Sun } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { PageIntro } from "../../components/page-intro";
import { Button, Card, Input, PasswordInput } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppearance } from "../../lib/use-appearance";

export function ProfilePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const { theme, setTheme } = useAppearance();
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);

  const closePasswordEditor = () => {
    setEditingPassword(false);
    setCurrentPassword("");
    setNewPassword("");
    setPasswordError("");
  };

  return (
    <AppShell>
      <div className="management-page profile-page">
        <PageIntro
          label="ACCOUNT"
          title="Your profile"
          description="View your account details and choose what to update."
        />
        {me.isPending ? (
          <Card className="management-card">
            <p>Loading profile…</p>
          </Card>
        ) : me.isError ? (
          <Card className="management-card">
            <h2>Profile unavailable</h2>
            <p role="alert">{me.error.message}</p>
            <Button variant="secondary" onClick={() => void me.refetch()}>
              Try again
            </Button>
          </Card>
        ) : (
          <>
            <Card className="management-card">
              <div className="management-card-heading">
                <div>
                  <h2>Personal details</h2>
                  <p className="profile-card-description">Your name is shown to people you work with.</p>
                </div>
                {!editingProfile && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={editingPassword}
                    onClick={() => {
                      setNameDraft(me.data.name);
                      setProfileError("");
                      setProfileSaved(false);
                      closePasswordEditor();
                      setEditingProfile(true);
                    }}
                  >
                    <Pencil size={15} /> Edit profile
                  </Button>
                )}
              </div>
              {editingProfile ? (
                <form
                  className="profile-edit-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setProfileBusy(true);
                    setProfileError("");
                    try {
                      const user = await api.updateProfile(nameDraft.trim());
                      queryClient.setQueryData(["me"], user);
                      setEditingProfile(false);
                      setProfileSaved(true);
                    } catch (error) {
                      setProfileError(error instanceof Error ? error.message : "Could not save your profile");
                    } finally {
                      setProfileBusy(false);
                    }
                  }}
                >
                  <label htmlFor="profile-name">
                    Name
                    <Input
                      id="profile-name"
                      autoFocus
                      autoComplete="name"
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      minLength={2}
                      maxLength={100}
                      required
                    />
                  </label>
                  <div className="profile-readonly-field">
                    <span>Email</span>
                    <strong>{me.data.email}</strong>
                  </div>
                  {profileError && (
                    <p role="alert" className="form-error">
                      {profileError}
                    </p>
                  )}
                  <div className="profile-form-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={profileBusy}
                      onClick={() => setEditingProfile(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={profileBusy || nameDraft.trim() === me.data.name || nameDraft.trim().length < 2}
                    >
                      {profileBusy ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </form>
              ) : (
                <dl className="profile-summary">
                  <div>
                    <dt>Name</dt>
                    <dd>{me.data.name}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{me.data.email}</dd>
                  </div>
                </dl>
              )}
              {profileSaved && !editingProfile && (
                <p role="status" className="profile-success">
                  Profile updated.
                </p>
              )}
            </Card>
            <Card className="management-card">
              <div className="management-card-heading">
                <div>
                  <h2>Appearance</h2>
                  <p className="profile-card-description">Choose how Wooble looks on this device.</p>
                </div>
              </div>
              <fieldset className="appearance-options">
                <legend className="sr-only">Color theme</legend>
                <Button
                  type="button"
                  variant={theme === "light" ? "default" : "outline"}
                  aria-pressed={theme === "light"}
                  onClick={() => setTheme("light")}
                >
                  <Sun size={15} /> Light
                </Button>
                <Button
                  type="button"
                  variant={theme === "dark" ? "default" : "outline"}
                  aria-pressed={theme === "dark"}
                  onClick={() => setTheme("dark")}
                >
                  <Moon size={15} /> Dark
                </Button>
              </fieldset>
            </Card>
            <Card className="management-card">
              <div className="management-card-heading">
                <div>
                  <h2>Password</h2>
                  <p className="profile-card-description">Change your password when you need to.</p>
                </div>
                {!editingPassword && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={editingProfile}
                    onClick={() => {
                      setEditingProfile(false);
                      setProfileError("");
                      setPasswordError("");
                      setEditingPassword(true);
                    }}
                  >
                    <KeyRound size={15} /> Change password
                  </Button>
                )}
              </div>
              {editingPassword && (
                <form
                  className="profile-edit-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setPasswordBusy(true);
                    setPasswordError("");
                    try {
                      await api.changePassword(currentPassword, newPassword);
                      queryClient.clear();
                      await navigate({ to: "/login" });
                    } catch (error) {
                      setPasswordError(error instanceof Error ? error.message : "Could not change password");
                    } finally {
                      setPasswordBusy(false);
                    }
                  }}
                >
                  <div className="password-form-field">
                    <label htmlFor="profile-current-password">Current password</label>
                    <PasswordInput
                      id="profile-current-password"
                      autoFocus
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      required
                    />
                  </div>
                  <div className="password-form-field">
                    <label htmlFor="profile-new-password">New password</label>
                    <PasswordInput
                      id="profile-new-password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      minLength={12}
                      required
                    />
                    <small>Use at least 12 characters.</small>
                  </div>
                  {passwordError && (
                    <p role="alert" className="form-error">
                      {passwordError}
                    </p>
                  )}
                  <div className="profile-form-actions">
                    <Button type="button" variant="ghost" disabled={passwordBusy} onClick={closePasswordEditor}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={passwordBusy || currentPassword.length === 0 || newPassword.length < 12}
                    >
                      {passwordBusy ? "Changing…" : "Change password"}
                    </Button>
                  </div>
                </form>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
