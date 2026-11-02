// FE-09: the read-only explanation shown wherever a role (or a
// non-writable workspace) takes mutation actions away. Renders nothing
// when there is nothing to explain, so pages can mount it unconditionally
// and let the permissions core decide.
import { Eye } from 'lucide-react';

export default function ReadOnlyBanner({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <Eye size={16} className="text-slate-400 shrink-0" />
      <span className="text-sm text-slate-300">{reason}</span>
      <span className="badge badge-gray ml-auto shrink-0">read-only</span>
    </div>
  );
}
