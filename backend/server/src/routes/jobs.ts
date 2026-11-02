import { Router } from 'express';
import { one, q } from '../db.js';
import { enqueueJob, getJob, listJobs, type JobKind } from '../queue.js';
import { requireProjectRole } from '../auth.js';
import { asyncHandler } from '../errors.js';
import { validateBody, evalRequestSchema } from '../validate.js';
import {
  parsePagination, paginationError, buildPage,
} from '../paginate.js';

export const jobsRouter = Router();

/** Project the caller may act on, or null (unknown / outside their customers). */
async function scopedProject(req: any, projectId: string) {
  const project = (await one(`SELECT * FROM projects WHERE id = $1`, [projectId])) as any;
  if (!project) return null;
  // BE-09: platform admins bypass membership, consistent with
  // requireProjectRole/requireProjectRead (previously an admin without a
  // membership in the owning customer 404'd here after passing the role gate).
  if (req.auth?.isPlatformAdmin) return project;
  const member = (req.auth?.memberships ?? []).some((m: any) => m.customerId === project.customer_id);
  if (!member) return null;
  return project;
}

// POST /v1/projects/:id/compile — enqueue tool compilation (202, processed by the worker)
jobsRouter.post('/:id/compile', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res, next) => {
  const project = await scopedProject(req, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const { job, deduplicated } = await enqueueJob('compile', project.id, req.auth?.userId);
    res.status(202).json({ job, deduplicated });
  } catch (e) {
    next(e);
  }
}));

// POST /v1/projects/:id/eval — enqueue a sandbox evaluation run (202).
// Optional {tool_ids} scopes the run to a few tools for a quick demo loop;
// omitted means the whole toolset.
jobsRouter.post('/:id/eval', requireProjectRole(['owner', 'editor']), validateBody(evalRequestSchema), asyncHandler(async (req, res, next) => {
  const project = await scopedProject(req, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const { tool_ids } = req.body as { tool_ids?: string[] };
    if (tool_ids) {
      const rows = await q(`SELECT id, name, status FROM canonical_tools WHERE project_id = $1 AND id = ANY($2)`,
        [project.id, tool_ids]);
      const byId = new Map((rows as Array<{ id: string; name: string; status: string }>).map((r) => [r.id, r]));
      const unknown = tool_ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        return res.status(400).json({
          error: 'eval_unknown_tools',
          code: 'eval_unknown_tools',
          message: `Unknown tools for this project: ${unknown.join(', ')}`,
        });
      }
      // Eval never runs on unapproved drafts — the run would silently cover
      // fewer tools than asked, so this is a 400 naming the offenders.
      const unapproved = tool_ids.filter((id) => byId.get(id)!.status === 'candidate');
      if (unapproved.length > 0) {
        return res.status(400).json({
          error: 'eval_unapproved_tools',
          code: 'eval_unapproved_tools',
          message: `Evaluation runs on approved tools only — approve these first: ` +
            unapproved.map((id) => byId.get(id)!.name).join(', '),
        });
      }
    }
    const { job, deduplicated } = await enqueueJob('eval', project.id, req.auth?.userId,
      tool_ids ? { tool_ids } : undefined);
    res.status(202).json({ job, deduplicated });
  } catch (e) {
    next(e);
  }
}));

// GET /v1/projects/:id/jobs — recent jobs for a project (newest first).
// BE-08: standard keyset pagination; default limit 50, max 100.
jobsRouter.get('/:id/jobs', asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const project = await scopedProject(req, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const rows = await listJobs(project.id, pg.limit, pg.cursor);
  const page = buildPage(rows as Record<string, any>[], pg.limit, 'created_at', 'id');
  res.json({ jobs: page.items, pagination: page.meta });
}));

export const jobRouter = Router();

// GET /v1/jobs/:jobId — single job; scoped through its project.
jobRouter.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const project = await scopedProject(req, job.project_id);
  if (!project) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
}));

export const JOB_KINDS: JobKind[] = ['compile', 'eval'];
