import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileUp, Wrench, ClipboardCheck, FlaskConical,
  Rocket, Activity, Hexagon, ChevronRight, ChevronDown, FolderKanban,
  Check, ArrowRight, FolderPlus, Building2, Menu, X, LifeBuoy,
} from 'lucide-react';
import { cn } from '../shared/lib/utils';
import { useActiveProject, useFoundryStore, useReadiness } from './store';
import { formatTargets, statusLabel, statusTone } from '../data/projects';
import { getMe, shellFor } from '../data/api';
import { canCreateProject } from '../data/permissions';
import { sidebarModeForWidth, sidebarVisible, sidebarWidthForMode } from './responsive';
import { Badge } from '../shared/components/atoms';
import { beginLogin, isCognitoConfigured, isSignedIn, logout } from '../features/auth/cognito';

/** FE-01 prep: sign in/out against the Cognito hosted UI. Renders nothing until
 *  the pool exists (VITE_COGNITO_DOMAIN + VITE_COGNITO_CLIENT_ID) — local dev
 *  keeps the CF_DEV_AUTH bypass and shows no button. */
/** IN-09: dev-only persona switcher. Renders only in Vite dev builds; the
 *  server honors the persona headers only under CF_DEV_AUTH, so this is
 *  inert in production. Presets mirror real roles: a staff operator (no
 *  workspace), a customer owner (Dev Workspace, no Admin), any invited or
 *  new email — the default dev admin (both planes) stays available for
 *  seed/curl parity. */
const OPERATOR_EMAIL = 'operator@connectorfoundry.local';
const CUSTOMER_EMAIL = 'customer@connectorfoundry.local';

function PersonaSwitcher() {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('cf-dev-as') : null;
  const [mode, setMode] = useState(
    !stored ? 'default'
      : stored === OPERATOR_EMAIL ? 'operator'
        : stored === CUSTOMER_EMAIL ? 'customer'
          : 'custom',
  );
  const [email, setEmail] = useState(
    stored && stored !== OPERATOR_EMAIL && stored !== CUSTOMER_EMAIL ? stored : '',
  );
  if (!(import.meta as any).env?.DEV) return null;
  const apply = (as: string | null, admin: boolean) => {
    if (as) localStorage.setItem('cf-dev-as', as); else localStorage.removeItem('cf-dev-as');
    if (admin) localStorage.setItem('cf-dev-as-admin', '1'); else localStorage.removeItem('cf-dev-as-admin');
    window.location.reload();
  };
  const pick = (next: string) => {
    setMode(next);
    if (next === 'default') apply(null, false);
    if (next === 'operator') apply(OPERATOR_EMAIL, true);
    if (next === 'customer') apply(CUSTOMER_EMAIL, false);
  };
  return (
    <div className="flex items-center gap-1.5" title={`Acting as ${stored ?? 'dev@connectorfoundry.local (default dev admin)'}`}>
      <span className="text-[10px] font-mono text-slate-500 hidden xl:inline">PERSONA</span>
      <select
        aria-label="Dev persona"
        className="bg-ink-800 border border-white/10 rounded-md text-xs px-2 py-1.5 text-slate-300"
        value={mode}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="default">Dev admin · both planes</option>
        <option value="operator">Operator · staff only</option>
        <option value="customer">Customer · dev workspace</option>
        <option value="custom">Act as email…</option>
      </select>
      {mode === 'custom' && (
        <>
          <input
            className="bg-ink-800 border border-white/10 rounded-md text-xs px-2 py-1.5 text-slate-200 w-44"
            placeholder="person@acme.test"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn-secondary btn-sm" onClick={() => email.trim() && apply(email.trim(), false)}>
            Act as
          </button>
        </>
      )}
    </div>
  );
}

function AuthButton() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  if (!isCognitoConfigured()) return null;
  if (signedIn) {
    return (
      <button
        className="btn-secondary btn-sm"
        onClick={() => {
          logout();
          setSignedIn(false);
        }}
      >
        Sign out
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary btn-sm" onClick={() => void beginLogin()}>
        Sign in
      </button>
      <button className="btn-primary btn-sm" onClick={() => void beginLogin(true)}>
        Create account
      </button>
    </div>
  );
}

const navGroups = [
  {
    label: 'Build',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/import', label: 'API Source', icon: FileUp },
      { to: '/tools', label: 'Tools', icon: Wrench },
      { to: '/review', label: 'Review', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Release',
    items: [
      { to: '/evaluate', label: 'Evaluate', icon: FlaskConical },
      { to: '/publish', label: 'Publish', icon: Rocket },
    ],
  },
  {
    label: 'Run',
    items: [{ to: '/operate', label: 'Operate', icon: Activity }],
  },
  {
    label: 'Admin',
    items: [
      { to: '/admin/customers', label: 'Customers', icon: Building2 },
      // Workspace users live under /customers/:id/users, reached from the Customers screen.
    ],
  },
];

function snapshotLabel(): string {
  const now = new Date();
  const date = now
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .replace(',', '')
    .toUpperCase();
  const time = now
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' })
    .toUpperCase();
  return `SNAPSHOT · ${date} · ${time} PT`;
}

function ProjectSwitcher() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const activeProjectId = useFoundryStore((s) => s.activeProjectId);
  const setActiveProject = useFoundryStore((s) => s.setActiveProject);
  const projects = useFoundryStore((s) => s.projects);
  // FE-09: viewers (and members of read-only workspaces) are never
  // offered project creation the API would refuse.
  const canCreate = canCreateProject(useFoundryStore((s) => s.me));
  const project = useActiveProject();

  const pick = (id: string) => {
    setActiveProject(id);
    setOpen(false);
    navigate('/dashboard');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-slate-400 hover:text-slate-100 transition-colors"
      >
        Projects
        <ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-7 z-40 w-80 max-w-[calc(100vw-2rem)] card p-2 shadow-card">
            <div className="micro-label px-3 pt-2 pb-1.5">Switch project</div>
            {projects.map((p) => {
              const isActive = p.id === activeProjectId;
              return (
                <button
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                    isActive ? 'bg-neon/10' : 'hover:bg-white/5',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-100 truncate">{p.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">→ {formatTargets(p.targets)}</div>
                  </div>
                  <Badge tone={statusTone[p.status]} className="!text-[10px] shrink-0">
                    {statusLabel[p.status]}
                  </Badge>
                  {isActive && <Check size={16} className="text-neon shrink-0" />}
                </button>
              );
            })}
            <div className="border-t border-white/10 mt-1.5 pt-1.5 px-1 pb-1 space-y-0.5">
              {canCreate && (
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/projects/new');
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-neon hover:bg-neon/10 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <FolderPlus size={14} /> New project
                </span>
                <ArrowRight size={14} className="text-slate-500" />
              </button>
              )}
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/projects');
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-white/5 transition-colors"
              >
                View all projects
                <ArrowRight size={14} className="text-slate-500" />
              </button>
            </div>
          </div>
        </>
      )}
      {project && <span className="sr-only">{project.name}</span>}
    </div>
  );
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();

  // FE-06: sidebar mode follows the viewport — full ≥1280, icon rail
  // 1024–1279, off-canvas drawer below that (see app/responsive.ts).
  // Width is tracked in state so crossing a breakpoint re-renders the
  // shell; the drawer closes itself on every navigation.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);
  const sidebarMode = sidebarModeForWidth(viewportWidth);
  const showSidebar = sidebarVisible(sidebarMode, drawerOpen);
  const isRail = sidebarMode === 'rail';

  // FE-13: the shell follows the signed-in identity (platform operator vs
  // workspace member), resolved once from /v1/me. Staff with no workspace
  // membership get the operator plane only and land on Admin → Customers;
  // tenant users never see Admin. The API remains the real gate
  // (requirePlatformAdmin) — this keeps each plane's UI honest.
  // FE-09: the identity also lives in the store so every page can derive
  // its role-gated controls from the same /v1/me payload.
  const me = useFoundryStore((s) => s.me);
  const setMe = useFoundryStore((s) => s.setMe);
  useEffect(() => {
    let live = true;
    getMe().then((m) => { if (live) setMe(m); }).catch(() => { /* fail-closed shell */ });
    return () => { live = false; };
  }, [setMe]);
  const { showAdmin, showTenant, landing } = shellFor(me);

  useEffect(() => {
    if (!me) return;
    const path = location.pathname;
    if (path.startsWith('/auth/') || path === '/signup' || path === landing || path === '/organizations/new') return;
    const onAdminPlane = path.startsWith('/admin');
    if ((onAdminPlane && !showAdmin) || (!onAdminPlane && !showTenant)) {
      navigate(landing, { replace: true });
    }
  }, [me, showAdmin, showTenant, landing, location.pathname, navigate]);

  // The project registry (and with it the active project's data) loads once the
  // identity says this user has a workspace.
  const loadProjects = useFoundryStore((s) => s.loadProjects);
  useEffect(() => {
    if (me && showTenant) void loadProjects();
  }, [me, showTenant, loadProjects]);

  const { blockerCount, findings } = useReadiness();
  const project = useActiveProject();
  const badgeBlockers = blockerCount;
  const badgeQuestions = findings.filter((f) => f.severity === 'warning' && f.status === 'open').length;

  return (
    <div className="min-h-screen flex">
      {/* FE-06: backdrop for the off-canvas drawer (overlay mode only) */}
      {sidebarMode === 'overlay' && showSidebar && (
        <div
          className="fixed inset-0 z-20 bg-black/60"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Sidebar — full (≥1280), icon rail (1024–1279), drawer (<1024) */}
      <aside
        className={cn(
          'shrink-0 bg-ink-900/95 border-r border-white/10 flex flex-col fixed inset-y-0 z-30 transition-transform duration-200',
          sidebarMode === 'full' && 'w-64',
          isRail && 'w-[72px]',
          sidebarMode === 'overlay' && cn('w-64', showSidebar ? 'translate-x-0' : '-translate-x-full'),
        )}
      >
        <div className={cn('py-5 border-b border-white/10', isRail ? 'px-3' : 'px-5')}>
          <div className={cn('flex items-center gap-2.5', isRail && 'justify-center')}>
            <div className="w-9 h-9 shrink-0 rounded-lg bg-neon/15 border border-neon/30 flex items-center justify-center shadow-glow">
              <Hexagon className="w-5 h-5 text-neon" />
            </div>
            {!isRail && (
            <div className="min-w-0">
              <div className="font-display font-semibold text-white leading-tight tracking-wide">CONNECTOR FOUNDRY</div>
              <div className="text-[11px] text-slate-500 font-mono truncate">
                {project ? project.name.toUpperCase() : 'NO PROJECT YET'}
              </div>
            </div>
            )}
            {sidebarMode === 'overlay' && (
              <button
                className="ml-auto text-slate-400 hover:text-slate-100"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
              >
                <X size={18} />
              </button>
            )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {showTenant && (
          <div>
            <NavLink
              to="/projects"
              title="Projects"
              className={({ isActive }) =>
                cn(
                  'relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isRail && 'justify-center px-0',
                  isActive ? 'bg-neon/10 text-neon' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-neon rounded-full shadow-glow" />
                  )}
                  <FolderKanban className="w-[18px] h-[18px] shrink-0" />
                  {!isRail && 'Projects'}
                </>
              )}
            </NavLink>
          </div>
          )}

          {navGroups
            .filter((group) => (group.label === 'Admin' ? showAdmin : showTenant))
            .map((group) => (
            <div key={group.label}>
              {!isRail && (
              <div className="px-3 mb-1.5 micro-label">
                {group.label}
              </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={item.label}
                    className={({ isActive }) =>
                      cn(
                        'relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                        isRail && 'justify-center px-0',
                        isActive
                          ? 'bg-neon/10 text-neon'
                          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-neon rounded-full shadow-glow" />
                        )}
                        <item.icon className="w-[18px] h-[18px] shrink-0" />
                        {!isRail && item.label}
                        {!isRail && item.to === '/review' && badgeQuestions > 0 && (
                          <span className="ml-auto badge badge-amber !px-2 !py-0 text-[11px] font-semibold">
                            {badgeQuestions}
                          </span>
                        )}
                        {!isRail && item.to === '/dashboard' && badgeBlockers > 0 && (
                          <span className="ml-auto badge badge-red !px-2 !py-0 text-[11px] font-semibold">
                            {badgeBlockers}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {!isRail && (
        <div className="px-5 py-4 border-t border-white/10">
          {/* CD-04: a human is always one click away, on every plane. */}
          <div>
            <div className="flex items-center gap-2">
              <LifeBuoy size={14} className="text-neon shrink-0" />
              <span className="micro-label">Need help?</span>
            </div>
            <a
              href="mailto:hello@connectorfoundry.com?subject=Support%20request"
              className="mt-1.5 block text-xs text-slate-300 hover:text-neon transition-colors break-all"
            >
              hello@connectorfoundry.com
            </a>
            <div className="mt-1 text-[11px] leading-snug text-slate-500">
              We reply within 1 business day. Include your workspace and the request_id from any failing call.
            </div>
          </div>
        </div>
        )}
      </aside>

      {/* Main — margin reserves exactly the sidebar's in-flow width (FE-06) */}
      <div
        className="flex-1 min-w-0 transition-[margin] duration-200"
        style={{ marginLeft: sidebarWidthForMode(sidebarMode) }}
      >
        <header className="bg-ink-900/80 backdrop-blur border-b border-white/10 px-4 sm:px-6 xl:px-8 py-3.5 flex items-center justify-between gap-3 flex-wrap sticky top-0 z-10">
          <div className="flex items-center gap-2 min-w-0">
            {sidebarMode === 'overlay' && (
              <button
                className="btn-secondary btn-sm !px-2"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
              >
                <Menu size={16} />
              </button>
            )}
            {showTenant ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0">
              <ProjectSwitcher />
              <ChevronRight className="w-4 h-4 shrink-0" />
              <span className="text-slate-200 font-medium truncate">
                {project ? `${project.name} → ${formatTargets(project.targets)}` : 'No project yet'}
              </span>
            </div>
            ) : (
              <div className="text-sm text-slate-500 font-medium">Platform operations</div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="snapshot-pill hidden md:inline-flex">
              <span className="live-dot" />
              {snapshotLabel()}
            </span>
            <PersonaSwitcher />
            <AuthButton />
            <div className="w-8 h-8 shrink-0 rounded-full bg-neon/15 border border-neon/30 text-neon flex items-center justify-center text-sm font-semibold">
              N
            </div>
          </div>
        </header>
        <main className="p-4 sm:p-6 xl:p-8 max-w-6xl w-full min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
