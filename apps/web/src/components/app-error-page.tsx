import { Link } from "@tanstack/react-router";
import { AlertCircle, RotateCw } from "lucide-react";
import { ApiError } from "../lib/api";
import { Button } from "./ui";

export function AppErrorPage({ error }: { error: unknown }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <main className="app-error-page">
      <Link to="/canvases" className="auth-brand" aria-label="Wooble canvases">
        <img src="/wooble-mark.svg" alt="" /> <span>wooble</span>
      </Link>
      <div className="app-error-content" role="alert">
        <span className="app-error-icon">
          <AlertCircle size={22} />
        </span>
        <h1>{forbidden ? "You can't open this page" : "We couldn't load this page"}</h1>
        <p>
          {forbidden
            ? "Ask a workspace manager for access, or return to your canvases."
            : "The service may be temporarily unavailable. Try again in a moment."}
        </p>
        <div className="app-error-actions">
          {!forbidden && (
            <Button onClick={() => window.location.reload()}>
              <RotateCw size={16} /> Try again
            </Button>
          )}
          <Link to="/canvases" className="action-link">
            Back to canvases
          </Link>
        </div>
      </div>
    </main>
  );
}
