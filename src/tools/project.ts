import { z } from "zod";
import { undoOp } from "../engine/apply.js";
import { Plan, PlanStep, Project, newId } from "../engine/project.js";
import { Ctx, Rich, boxArg, dimOf, dimension, registerTool, vec3 } from "./shared.js";

const stepInput = z.object({
  tool: z.string().describe("any tool name, e.g. generate, fill_region, run_commands"),
  args: z.record(z.string(), z.any()).default({}),
  note: z.string().optional(),
});

export function registerProject(ctx: Ctx) {
  const s = ctx.session;

  registerTool(ctx, "project_open", "Switch to (or create) a project. A project keeps design decisions, the palette, named regions, markers, the undo journal and build plans between sessions.", {
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  }, async (a) => {
    s.project = new Project(a.name);
    return { project: a.name, meta: s.project.meta, plans: s.project.plans().map((p) => ({ id: p.id, title: p.title })), others: Project.list() };
  });

  registerTool(ctx, "project_info", "Everything the current project remembers: decisions, palette, regions, plans with progress, recent ops.", {}, async () => {
    const ops = [...s.project.ops().values()].slice(-10).map((o) => ({ id: o.id, label: o.label, status: o.status, blocks: o.blocks, at: o.at }));
    return {
      project: s.project.name,
      decisions: s.project.meta.decisions,
      palette: s.project.meta.palette,
      regions: s.project.meta.regions,
      world: s.project.meta.world,
      plans: s.project.plans().map((p) => ({ id: p.id, title: p.title, progress: `${p.steps.filter((x) => x.status === "done").length}/${p.steps.length}` })),
      recentOps: ops,
    };
  }, { readOnlyHint: true });

  registerTool(ctx, "project_note", "Record a design decision that should hold for the rest of the project (style, scale, colour rules, gameplay constraints). remove takes the index of a note to drop.", {
    text: z.string().max(2000).optional(),
    remove: z.number().int().optional(),
  }, async (a) => {
    if (a.text) s.project.meta.decisions.push(a.text);
    if (a.remove !== undefined) s.project.meta.decisions.splice(a.remove, 1);
    s.project.saveMeta();
    return { decisions: s.project.meta.decisions };
  });

  registerTool(ctx, "region_mark", "Name a region (spawn area, arena, district...) so later requests can refer to it by name. Pass only name to delete.", {
    name: z.string().min(1).max(60),
    from: vec3.optional(), to: vec3.optional(),
    note: z.string().max(500).optional(),
    dimension,
  }, async (a) => {
    if (!a.from || !a.to) delete s.project.meta.regions[a.name];
    else s.project.meta.regions[a.name] = { dim: dimOf(a.dimension), box: boxArg(a.from, a.to), note: a.note };
    s.project.saveMeta();
    return { regions: s.project.meta.regions };
  });

  registerTool(ctx, "op_list", "Journal of world edits in this project, newest first, with status (done, partial, failed, undone) and whether they can be undone.", {
    limit: z.number().int().min(1).max(500).default(30),
  }, async (a) => [...s.project.ops().values()].reverse().slice(0, a.limit).map((o) => ({
    id: o.id, label: o.label, status: o.status, blocks: o.blocks, undoable: o.undoable && o.status !== "undone", world: o.world, at: o.at,
    tiles: `${o.tiles.filter((t) => t.status === "done").length}/${o.tiles.length}`,
  })), { readOnlyHint: true });

  registerTool(ctx, "op_undo", "Undo an edit by putting back what was there before. Refuses when a later edit overlaps it (undo that first) unless force. Without op_id it undoes the newest edit that isn't undone yet.", {
    op_id: z.string().optional(),
    force: z.boolean().default(false),
  }, async (a) => {
    let id = a.op_id;
    if (!id) {
      const last = [...s.project.ops().values()].reverse().find((o) => o.status !== "undone" && o.undoable);
      if (!last) throw new Error("nothing to undo in this project");
      id = last.id;
    }
    return undoOp(s.requireBackend(), s.project, id, a.force);
  }, { destructiveHint: true });

  registerTool(ctx, "plan_create", "Save a multi step build plan (big projects: terrain, then districts, then roads, then details). Steps are ordinary tool calls. Plans survive restarts and plan_run continues where it stopped.", {
    title: z.string().min(1).max(200),
    steps: z.array(stepInput).min(1).max(500),
  }, async (a) => {
    for (const st of a.steps) if (!ctx.handlers.has(st.tool) || st.tool.startsWith("plan_")) throw new Error(`step tool "${st.tool}" isn't usable in a plan`);
    const plan: Plan = {
      id: newId("plan"),
      title: a.title,
      created: new Date().toISOString(),
      steps: a.steps.map((st: z.infer<typeof stepInput>, i: number) => ({ id: `s${i + 1}`, action: st.tool, args: st.args, note: st.note, status: "pending" })),
    };
    s.project.savePlan(plan);
    return { plan: plan.id, steps: plan.steps.length };
  });

  registerTool(ctx, "plan_show", "Show a plan with each step's status, results and errors.", { plan: z.string() }, async (a) => s.project.plan(a.plan), { readOnlyHint: true });

  registerTool(ctx, "plan_list", "Plans in the current project with progress.", {}, async () => s.project.plans().map((p) => ({
    id: p.id, title: p.title, created: p.created,
    done: p.steps.filter((x) => x.status === "done").length, failed: p.steps.filter((x) => x.status === "failed").length, total: p.steps.length,
  })), { readOnlyHint: true });

  registerTool(ctx, "plan_edit", "Change a plan: append steps, insert after a step, or set a step's status (pending to rerun, skipped to jump over it).", {
    plan: z.string(),
    add: z.array(stepInput).optional(),
    after: z.string().optional(),
    set_status: z.record(z.string(), z.enum(["pending", "skipped", "done"])).optional(),
  }, async (a) => {
    const plan = s.project.plan(a.plan);
    if (a.add?.length) {
      for (const st of a.add) if (!ctx.handlers.has(st.tool) || st.tool.startsWith("plan_")) throw new Error(`step tool "${st.tool}" isn't usable in a plan`);
      let n = plan.steps.length;
      const fresh: PlanStep[] = a.add.map((st: z.infer<typeof stepInput>) => ({ id: `s${++n}`, action: st.tool, args: st.args, note: st.note, status: "pending" }));
      const at = a.after ? plan.steps.findIndex((x) => x.id === a.after) : -1;
      if (a.after && at < 0) throw new Error(`no step ${a.after}`);
      plan.steps.splice(at < 0 ? plan.steps.length : at + 1, 0, ...fresh);
    }
    for (const [id, st] of Object.entries(a.set_status ?? {})) {
      const step = plan.steps.find((x) => x.id === id);
      if (!step) throw new Error(`no step ${id}`);
      step.status = st as PlanStep["status"];
      if (st === "pending") step.error = undefined;
    }
    s.project.savePlan(plan);
    return plan;
  });

  registerTool(ctx, "plan_run", "Run a plan's pending steps in order (failed steps are retried). Interrupted world edits resume from the tiles they finished. Stops at the first error unless continue_on_error, and after max_steps so long plans can report progress.", {
    plan: z.string(),
    max_steps: z.number().int().min(1).max(500).default(50),
    continue_on_error: z.boolean().default(false),
  }, async (a) => {
    const plan = s.project.plan(a.plan);
    const ran: { step: string; tool: string; status: string; summary?: unknown; error?: string }[] = [];
    for (const step of plan.steps) {
      if (ran.length >= a.max_steps) break;
      if (step.status === "done" || step.status === "skipped") continue;
      const args = { ...step.args };
      // pick up an interrupted world edit instead of starting it over
      const lastOp = step.opIds?.[step.opIds.length - 1];
      if (step.action === "generate" && lastOp) {
        const o = s.project.ops().get(lastOp);
        if (o && (o.status === "partial" || o.status === "running")) args.resume_op = lastOp;
      }
      step.status = "running";
      s.project.savePlan(plan);
      try {
        const res = await ctx.handlers.get(step.action)!(args);
        const data = res instanceof Rich ? res.data : res;
        const rep = data as { opId?: string; status?: string; errors?: string[] };
        if (rep?.opId) step.opIds = [...(step.opIds ?? []), rep.opId];
        if (rep?.status === "partial" || rep?.status === "failed") {
          step.status = "failed";
          step.error = `world edit ${rep.status}: ${(rep.errors ?? []).slice(0, 3).join("; ")}`;
        } else {
          step.status = "done";
          step.error = undefined;
        }
        step.result = compact(data);
      } catch (e) {
        step.status = "failed";
        step.error = (e as Error).message;
      }
      s.project.savePlan(plan);
      ran.push({ step: step.id, tool: step.action, status: step.status, summary: step.result, error: step.error });
      if (step.status === "failed" && !a.continue_on_error) break;
    }
    const remaining = plan.steps.filter((x) => x.status === "pending" || x.status === "failed").length;
    return { plan: plan.id, ran, remaining, done: remaining === 0 };
  });
}

/** Keeps plan files small: drops long arrays and images, keeps ids, counts and statuses. */
function compact(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) out[k] = val.length > 10 ? `${val.length} items` : val;
    else if (val && typeof val === "object") out[k] = JSON.stringify(val).length > 400 ? "(omitted)" : val;
    else out[k] = val;
  }
  return out;
}
