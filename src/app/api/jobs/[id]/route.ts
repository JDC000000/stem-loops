import type { NextRequest } from "next/server";
import { getJob } from "@/lib/jobs-store";

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]">,
) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  return Response.json(job);
}
