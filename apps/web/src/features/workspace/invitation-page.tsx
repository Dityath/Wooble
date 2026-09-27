import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MailOpen } from "lucide-react";
import { Button, Card } from "../../components/ui";
import { api } from "../../lib/api";

export function InvitationPage() {
  const { token } = useParams({ from: "/invite/$token" });
  const query = useQuery({ queryKey: ["invitation", token], queryFn: () => api.invitation(token), retry: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <div className="invitation-page">
      <Link to="/canvases" className="auth-brand">
        <img src="/wooble-mark.svg" alt="" />
        <span>wooble</span>
      </Link>
      <Card className="invitation-card">
        <span className="auth-lock">
          <MailOpen size={20} />
        </span>
        <span className="eyebrow">INVITATION</span>
        <h1>
          {query.data?.canvasName
            ? `Join ${query.data.canvasName}`
            : query.data?.workspaceName
              ? `Join ${query.data.workspaceName}`
              : "Open invitation"}
        </h1>
        {query.isPending ? (
          <p>Checking your link…</p>
        ) : query.isError ? (
          <p>{query.error.message}</p>
        ) : (
          <>
            <p>
              {query.data?.canvasName
                ? `You'll join ${query.data.workspaceName} with ${query.data.role} access to this canvas.`
                : "You'll join this workspace. Its canvases will appear when a manager shares them with you."}
            </p>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await api.acceptInvitation(token);
                  await queryClient.invalidateQueries();
                  await navigate(
                    result.canvasId
                      ? { to: "/canvases/$canvasId", params: { canvasId: result.canvasId } }
                      : { to: "/canvases", search: { workspaceId: result.workspaceId } },
                  );
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not accept invitation");
                  setBusy(false);
                }
              }}
            >
              Accept invitation <ArrowRight size={15} />
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}
