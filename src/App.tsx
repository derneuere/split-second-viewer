import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/context/WorkspaceContext";
import { AppHeader } from "@/components/layout/AppHeader";
import WorkspaceEditor from "@/pages/WorkspaceEditor";
import Docs from "@/pages/Docs";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
	<QueryClientProvider client={queryClient}>
		<TooltipProvider>
			<Toaster />
			<BrowserRouter>
				<WorkspaceProvider>
					<div className="flex h-full flex-col">
						<AppHeader />
						<main className="flex flex-1 flex-col overflow-hidden">
							<Routes>
								{/* "/" is the single primary page: the Workspace editor. */}
								<Route path="/" element={<WorkspaceEditor />} />
								{/* Legacy /workspace links redirect to the new home. */}
								<Route path="/workspace" element={<Navigate to="/" replace />} />
								<Route path="/docs" element={<Docs />} />
								<Route path="*" element={<NotFound />} />
							</Routes>
						</main>
					</div>
				</WorkspaceProvider>
			</BrowserRouter>
		</TooltipProvider>
	</QueryClientProvider>
);

export default App;
