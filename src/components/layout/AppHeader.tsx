import { Link, useLocation } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
	{ to: '/', label: 'Workspace' },
	{ to: '/docs', label: 'Docs' },
];

export function AppHeader() {
	const { pathname } = useLocation();
	return (
		<header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card/60 px-4 backdrop-blur">
			<Link to="/" className="flex items-center gap-2 font-semibold text-primary">
				<Gauge className="h-5 w-5" />
				<span>Split/Second Steward</span>
			</Link>
			<nav className="flex items-center gap-1 text-sm">
				{NAV.map((item) => {
					const active =
						item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
					return (
						<Link
							key={item.to}
							to={item.to}
							className={cn(
								'rounded-md px-3 py-1 transition-colors',
								active
									? 'bg-primary/20 text-primary'
									: 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
							)}
						>
							{item.label}
						</Link>
					);
				})}
			</nav>
			<span className="ml-auto text-xs text-muted-foreground">
				PS3 · big-endian · read-only MVP
			</span>
		</header>
	);
}

export default AppHeader;
