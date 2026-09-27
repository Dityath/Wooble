import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { CanvasLibraryPage } from "../features/workspace/canvas-library";
import {
  WorkspaceSettingsPage,
  CanvasSettingsPage,
  NewWorkspacePage,
  NoWorkspacePage,
} from "../features/workspace/workspace-pages";
import { InvitationPage } from "../features/workspace/invitation-page";
import { EntityDetailPage } from "../features/entity/entity-detail-page";
import { LoginPage, RegisterPage } from "../features/auth/auth-pages";
import { AdminPage } from "../features/auth/admin-page";
import { ProfilePage } from "../features/auth/profile-page";
import { api, ApiError } from "../lib/api";
import { AppErrorPage } from "../components/app-error-page";

const rootRoute = createRootRoute({ component: () => <Outlet />, errorComponent: AppErrorPage });
const authSearch = (search: Record<string, unknown>): { returnTo?: string } => ({
  returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
});
const protect = async () => {
  try {
    await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      throw redirect({ to: "/login", search: { returnTo: `${window.location.pathname}${window.location.search}` } });
    throw error;
  }
};
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/canvases" });
  },
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: authSearch,
  component: LoginPage,
});
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: authSearch,
  component: RegisterPage,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/canvases",
  validateSearch: (search: Record<string, unknown>): { workspaceId?: string } => ({
    workspaceId: typeof search.workspaceId === "string" ? search.workspaceId : undefined,
  }),
  beforeLoad: protect,
  component: CanvasLibraryPage,
});
const canvasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/canvases/$canvasId",
  component: lazyRouteComponent(() => import("../features/canvas/canvas-page"), "CanvasPage"),
});
const canvasSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/canvases/$canvasId/manage",
  beforeLoad: protect,
  component: CanvasSettingsPage,
});
const newWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/new",
  beforeLoad: protect,
  component: NewWorkspacePage,
});
const noWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/no-workspace",
  beforeLoad: protect,
  component: NoWorkspacePage,
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId",
  beforeLoad: async ({ params }) => {
    await protect();
    throw redirect({ to: "/canvases", search: { workspaceId: params.workspaceId } });
  },
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/settings",
  beforeLoad: protect,
  component: WorkspaceSettingsPage,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/users",
  beforeLoad: protect,
  component: AdminPage,
});
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: protect,
  component: ProfilePage,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  beforeLoad: protect,
  component: InvitationPage,
});
const entityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/entities/$entityId",
  validateSearch: (search: Record<string, unknown>): { canvasId?: string } => ({
    canvasId: typeof search.canvasId === "string" ? search.canvasId : undefined,
  }),
  component: EntityDetailPage,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  libraryRoute,
  canvasRoute,
  canvasSettingsRoute,
  newWorkspaceRoute,
  noWorkspaceRoute,
  workspaceRoute,
  workspaceSettingsRoute,
  adminRoute,
  profileRoute,
  inviteRoute,
  entityRoute,
]);
export const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
