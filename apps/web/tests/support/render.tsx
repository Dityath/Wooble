import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { TooltipProvider } from "../../src/components/ui";
import { router as appRouter } from "../../src/routes/router";

export function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/**
 * Renders the real route tree at `path`, with a fresh router and query cache for each test.
 * RouterProvider loads the route once, as in the browser; tests wait for UI with findBy/waitFor.
 */
export async function renderRoute(path: string) {
  window.history.replaceState(null, "", path);
  const queryClient = testQueryClient();
  const router = createRouter({ routeTree: appRouter.routeTree, history: createBrowserHistory() });
  const user = userEvent.setup({ delay: null });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user };
}

/** Renders a component that needs query context but no routing. `rerender` keeps the providers. */
export function renderWithQuery(ui: ReactNode, queryClient = testQueryClient()) {
  const user = userEvent.setup({ delay: null });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), queryClient, user };
}
