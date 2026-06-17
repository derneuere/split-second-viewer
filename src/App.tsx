import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/context/WorkspaceContext";
import { AppHeader } from "@/components/layout/AppHeader";
import Home from "@/pages/Home";
import WorkspaceEditor from "@/pages/WorkspaceEditor";
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
								<Route path="/" element={<Home />} />
								<Route path="/workspace" element={<WorkspaceEditor />} />
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
