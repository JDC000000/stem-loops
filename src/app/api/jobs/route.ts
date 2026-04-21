import { NextRequest } from "next/server";
import {
  createJob,
  FREE_LIMIT,
  getIpJobCount,
  incrementIpJobCount,
} from "@/lib/jobs-store";
import { ALL_STEMS, BAR_OPTIONS, JobRequest } from "@/lib/types";

const YT_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\/.+/i;

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function isAuthenticated(req: NextRequest): boolean {
  // TODO: wire NextAuth session check. For now, treat a cookie named
  // `stem-loops-session` as logged in — lets you test the freemium wall.
  return req.cookies.get("stem-loops-session")?.value === "ok";
}

export async function POST(req: NextRequest) {
  let body: Partial<JobRequest>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate
  if (!body.url || typeof body.url !== "string" || !YT_REGEX.test(body.url)) {
    return Response.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }
  if (
    !Array.isArray(body.stems) ||
    body.stems.length === 0 ||
    !body.stems.every((s) => ALL_STEMS.includes(s))
  ) {
    return Response.json({ error: "Pick at least one stem" }, { status: 400 });
  }
  if (!body.bars || !BAR_OPTIONS.includes(body.bars)) {
    return Response.json({ error: "Invalid bar count" }, { status: 400 });
  }

  // Freemium check
  if (!isAuthenticated(req)) {
    const ip = getClientIp(req);
    const count = await getIpJobCount(ip);
    if (count >= FREE_LIMIT) {
      return Response.json(
        {
          error:
            "Free limit reached. Sign in with Google to keep extracting loops.",
          freeUsed: count,
          freeLimit: FREE_LIMIT,
        },
        { status: 402 },
      );
    }
    await incrementIpJobCount(ip);
  }

  const job = await createJob({
    url: body.url,
    stems: body.stems,
    bars: body.bars,
  });

  return Response.json({ id: job.id }, { status: 201 });
}

export async function GET() {
  return Response.json({
    status: "ok",
    service: "stem-loops",
    freeLimit: FREE_LIMIT,
  });
}
