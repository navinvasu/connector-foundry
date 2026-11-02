// Shown by every build screen until the workspace has a project (D-87: there
// is no sample project to fall back to).
import { Link } from 'react-router-dom';
import { useFoundryStore } from '../../app/store';
import { EmptyState, LoadingState } from './atoms';

export default function NoProject() {
  const loaded = useFoundryStore((s) => s.projectsLoaded);
  if (!loaded) return <LoadingState label="Loading projects…" />;
  return (
    <EmptyState
      title="No project yet"
      sub="Create a project and import your API's OpenAPI spec to start building a connector."
      action={<Link to="/projects/new" className="btn-primary btn-sm">New project</Link>}
    />
  );
}
