import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "../../components/app-shell";
import { PageIntro } from "../../components/page-intro";
import { Card } from "../../components/ui";
import { api } from "../../lib/api";

export function AdminPage() {
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  return (
    <AppShell>
      <div className="management-page">
        <PageIntro
          label="SYSTEM ADMIN"
          title="Users"
          description="Choose who can manage all workspaces and canvases."
        />
        <Card className="management-card">
          <h2>Registered users</h2>
          {users.isPending ? (
            <p>Loading users…</p>
          ) : users.isError ? (
            <p role="alert">{users.error.message}</p>
          ) : (
            <div className="member-list">
              {users.data?.map((user) => (
                <div className="member-row" key={user.id}>
                  <span className="member-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                  </div>
                  <select
                    aria-label={`System role for ${user.name}`}
                    value={user.systemRole}
                    onChange={async (event) => {
                      setError("");
                      try {
                        await api.updateSystemRole(user.id, event.target.value as "admin" | "user");
                        await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "Could not update role");
                      }
                    }}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
