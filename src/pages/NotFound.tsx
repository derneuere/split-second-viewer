import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<h1 className="text-4xl font-bold text-primary">404</h1>
			<p className="text-muted-foreground">This page does not exist.</p>
			<Button asChild>
				<Link to="/">Back home</Link>
			</Button>
		</div>
	);
}

export default NotFound;
