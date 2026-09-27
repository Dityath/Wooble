import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Box, Cpu, Database, ExternalLink, GitBranch, Layers3, Server } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { Badge, Card, CardTitle } from "../../components/ui";
import { api } from "../../lib/api";
import { MarkdownContent } from "../inspector/rich-documentation";
import { DatabaseSchema } from "../inspector/database-schema";

const iconMap: Record<string, typeof Server> = {
  system: Layers3,
  frontend: Box,
  device: Cpu,
  gateway: GitBranch,
  service: Server,
  database: Database,
};
const typeName: Record<string, string> = {
  system: "System",
  frontend: "Frontend",
  device: "IoT device",
  gateway: "API gateway",
  service: "Service",
  database: "Database",
  broker: "Message broker",
  external: "External",
};

export function EntityDetailPage() {
  const { entityId } = useParams({ from: "/entities/$entityId" });
  const { canvasId } = useSearch({ from: "/entities/$entityId" });
  const query = useQuery({ queryKey: ["entity", entityId, canvasId], queryFn: () => api.entity(entityId, canvasId) });
  if (query.isPending)
    return (
      <AppShell>
        <div className="detail-loading">Loading entity…</div>
      </AppShell>
    );
  if (query.isError)
    return (
      <AppShell>
        <div className="load-error">
          <h2>Entity unavailable</h2>
          <p>{query.error.message}</p>
        </div>
      </AppShell>
    );
  const entity = query.data;
  const Icon = iconMap[entity.type] ?? Box;
  return (
    <AppShell workspaceId={entity.workspaceId} canvasId={canvasId}>
      <div className="entity-detail-page">
        <Link
          to={canvasId ? "/canvases/$canvasId" : "/canvases"}
          params={canvasId ? { canvasId } : (undefined as never)}
          className="back-link"
        >
          <ArrowLeft size={14} /> Back to {canvasId ? "canvas" : "library"}
        </Link>
        <div className="entity-detail-heading">
          <span className={`inspector-kind-icon kind-${entity.type}`}>
            <Icon size={20} />
          </span>
          <div>
            <div className="eyebrow">{typeName[entity.type] ?? "Entity"}</div>
            <h1>{entity.name}</h1>
            <p>{entity.description}</p>
          </div>
        </div>
        <Card className="entity-detail-card">
          <CardTitle>Details</CardTitle>
          <div className="entity-detail-grid">
            <Detail label="Type">
              <Badge>{typeName[entity.type] ?? entity.type}</Badge>
            </Detail>
            <Detail label="Language" value={entity.metadata.language} />
            <Detail label="Framework" value={entity.metadata.framework} />
            <Detail label="Database engine" value={entity.metadata.engine} />
            <Detail label="Version" value={entity.metadata.version} />
            <Detail label="API protocols">
              {entity.metadata.interfaces?.map((item) => (
                <Badge key={item}>{item}</Badge>
              ))}
            </Detail>
            <Detail label="Repository">
              {entity.metadata.repositoryUrl ? (
                <a href={entity.metadata.repositoryUrl} target="_blank" rel="noreferrer">
                  Open repository <ExternalLink size={12} />
                </a>
              ) : null}
            </Detail>
            <Detail label="Artifact">
              {entity.metadata.artifactUrl ? <span>{entity.metadata.artifactUrl}</span> : null}
            </Detail>
          </div>
        </Card>
        {entity.type === "database" && <DatabaseSchema value={entity.metadata.schemaSql ?? ""} />}
        <section className="rich-detail-card">
          <div className="rich-detail-heading">
            <div>
              <h3>Documentation</h3>
              <p>Architecture notes and usage context</p>
            </div>
          </div>
          <MarkdownContent value={entity.metadata.documentation ?? ""} />
        </section>
      </div>
    </AppShell>
  );
}

function Detail({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="entity-detail-field">
      <span>{label}</span>
      <div>{children ?? value ?? <em>Not configured</em>}</div>
    </div>
  );
}
